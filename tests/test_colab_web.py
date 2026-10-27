"""Browser workflow contracts, authenticated HTTP, recovery and tunnel isolation."""
import base64
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import colab_web as web
import colab_tunnel as tunnel


def settings():
    return {"mode": "structured-script", "target": 60, "scene_seconds": 5,
            "context": "", "seed": 42, "preset": "768x1344", "fit": "pad"}


def plan():
    return {"title": "Episode", "context": "Same people", "scenes": [{"prompt": "A short scene", "duration": 5}]}


class DashboardFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        (self.runtime / "runtime-lock.json").write_text('{"comfy_commit":"test","model_commit":"test"}')
        self.app = web.Dashboard(self.root / "drive", self.runtime, "http://127.0.0.1:8188", "test-password-123")

    def tearDown(self):
        self.temp.cleanup()


class DashboardTest(DashboardFixture, unittest.TestCase):
    def test_validation_rejects_unsafe_references_and_invalid_duration(self):
        with self.assertRaises(ValueError):
            self.app.references(["../secret.png"])
        for duration in (True, float("nan"), 4, 16):
            p = plan()
            p["scenes"][0]["duration"] = duration
            with self.assertRaises(ValueError):
                web.validate_plans([p])
        with self.assertRaises(ValueError):
            web.Dashboard(self.root / "drive", self.runtime, "https://foreign.example", "test-password-123")

    def test_submit_is_serialized_and_worker_never_receives_tunnel_or_login_credentials(self):
        req = {"settings": settings(), "plans": [plan()], "references": []}
        with patch.object(web.subprocess, "Popen") as spawn, patch.object(web.threading, "Thread"), patch.dict(os.environ, {"REELS_WEB_PASSWORD": "private-password", "TUNNEL_TOKEN": "private-token"}):
            first = self.app.submit("generate", req)
            with self.assertRaisesRegex(ValueError, "Another job"):
                self.app.submit("test", req)
            env = spawn.call_args.kwargs["env"]
            self.assertNotIn("REELS_WEB_PASSWORD", env)
            self.assertNotIn("TUNNEL_TOKEN", env)
            self.assertTrue(spawn.call_args.kwargs["start_new_session"])
            saved = json.loads((self.app.folder / "jobs" / first["id"] / "request.json").read_text())
            self.assertEqual(saved["plans"], [plan()])
            self.assertEqual(saved["runtime"], str(self.runtime.resolve()))

    def test_restart_retains_job_history_but_marks_lost_workers_interrupted(self):
        job = {"id": "old-job", "action": "generate", "status": "running", "created": 1}
        self.app.save_job(job)
        restored = web.Dashboard(self.app.workspace, self.runtime, self.app.url, "test-password-123")
        self.assertEqual(restored.jobs[0]["status"], "interrupted")
        self.assertFalse(restored.snapshot()["busy"])

    def test_monitor_only_publishes_successful_full_batches_for_release(self):
        job = {"id": "complete", "action": "generate", "status": "running", "created": 1}
        self.app.save_job(job)
        folder = self.app.folder / "jobs" / job["id"]
        (folder / "result.json").write_text(json.dumps({"outputs": ["example.mp4"], "test": False}))
        self.app.monitor(job, Mock(wait=Mock(return_value=0)))
        self.assertEqual(job["status"], "done")
        self.assertEqual(json.loads((self.app.folder / "last-generation.json").read_text())["job_id"], "complete")
        failed = dict(job, id="failed", status="running")
        self.app.save_job(failed)
        self.app.monitor(failed, Mock(wait=Mock(return_value=1)))
        self.assertEqual(failed["status"], "error")

    def test_cancel_stops_worker_group_and_only_interrupts_owned_backend_prompts(self):
        from colab_drama import atomic_json
        state = self.app.workspace / "episodes" / "managed" / "scene-001.json"
        atomic_json(state, {"fingerprint": "owned-token"})
        self.app.current = {"id": "active", "status": "running", "action": "generate", "created": 1}
        self.app.process = Mock(pid=12345)
        queue = {"queue_running": [[0, "foreign-prompt", {}, {"drama_token": "foreign-token"}]],
                 "queue_pending": [[1, "owned-prompt", {}, {"drama_token": "owned-token"}]]}
        with patch("colab_runtime.api", return_value=queue) as api, patch.object(web.os, "killpg") as kill:
            self.app.cancel()
            kill.assert_called_once_with(12345, web.signal.SIGTERM)
            self.assertEqual([call.args[1] for call in api.call_args_list], ["/queue", "/queue"])
            self.assertEqual(api.call_args_list[1].args[2], {"delete": ["owned-prompt"]})
            self.assertEqual(self.app.current["status"], "cancelled")

    def test_backend_cancel_failure_is_reported_instead_of_claiming_cancellation(self):
        self.app.current = {"id": "active", "status": "running", "action": "generate", "created": 1}
        self.app.process = Mock(pid=12345)
        with patch("colab_runtime.api", side_effect=RuntimeError("backend gone")), patch.object(web.os, "killpg"):
            self.app.cancel()
        self.assertEqual(self.app.current["status"], "error")
        self.assertIn("could not be confirmed", self.app.current["error"])

    def test_structured_planning_worker_bypasses_qwen_and_preserves_script(self):
        from colab_drama import atomic_json
        request = {"action": "plan", "workspace": str(self.app.workspace), "runtime": str(self.runtime),
                   "url": self.app.url, "settings": settings(), "references": [],
                   "sources": [{"title": "Uploaded script", "text": (ROOT / "the-last-slice-s01e01.txt").read_text()}]}
        path = self.app.folder / "jobs" / "planning" / "request.json"
        atomic_json(path, request)
        with patch("colab_runtime.api", return_value={}), patch("colab_planner.plan_story") as planner:
            web.worker(path)
        planner.assert_not_called()
        result = json.loads((path.parent / "result.json").read_text())
        self.assertEqual(len(result["plans"][0]["scenes"]), 12)
        self.assertEqual(result["plans"][0]["title"], "The Last Slice — S01E01")
        self.assertEqual(result, json.loads((self.app.folder / "last-plan.json").read_text()))

    def test_test_worker_uses_five_seconds_and_preserves_reviewed_full_plan(self):
        from colab_drama import atomic_json
        reviewed = plan()
        reviewed["scenes"][0]["duration"] = 10
        req = {"action": "test", "workspace": str(self.app.workspace), "runtime": str(self.runtime),
               "url": self.app.url, "settings": settings(), "references": [], "plans": [reviewed]}
        path = self.app.folder / "jobs" / "test-scene" / "request.json"
        atomic_json(path, req)
        with patch("colab_drama.run_episode", return_value=Path("test.mp4")) as run, patch("colab_finish.finish_run") as finish:
            web.worker(path)
        actual = run.call_args.args[0]
        self.assertEqual(actual["scenes"][0]["duration"], 5)
        self.assertEqual(req["plans"][0]["scenes"][0]["duration"], 10)
        self.assertEqual(run.call_args.kwargs["preset"], "768x1344")
        self.assertFalse(finish.call_args.kwargs["auto_disconnect"])

    def test_release_requires_successful_latest_batch_and_verifies_before_signalling_notebook(self):
        from colab_drama import atomic_json
        with self.assertRaises(ValueError):
            self.app.release()
        atomic_json(self.app.folder / "last-generation.json", {"outputs": ["episode.mp4"], "job_id": "render"})
        self.app.jobs = [{"id": "render", "action": "generate", "status": "error"}]
        with self.assertRaises(ValueError):
            self.app.release()
        self.app.jobs[0]["status"] = "done"
        with patch("colab_finish.finish_run", side_effect=RuntimeError("missing scene")):
            with self.assertRaises(RuntimeError):
                self.app.release()
        self.assertFalse((self.runtime / "web-release.json").exists())
        with patch("colab_finish.finish_run") as finish:
            self.app.release()
        self.assertFalse(finish.call_args.kwargs["auto_disconnect"])
        self.assertTrue((self.runtime / "web-release.json").is_file())
        self.assertTrue(self.app.releasing)


class HttpTest(DashboardFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
        self.server.app = self.app
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = ""

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        super().tearDown()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        final_headers = {"Cookie": self.cookie}
        if body is not None:
            body = json.dumps(body)
            final_headers.update({"Content-Type": "application/json", "X-Reels-Request": "1"})
        final_headers.update(headers or {})
        conn.request(method, path, body, final_headers)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def login(self):
        status, headers, _ = self.request("POST", "/api/login", {"password": "test-password-123"}, {"X-Forwarded-Proto": "https"})
        self.assertEqual(status, 200)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("Secure", headers["Set-Cookie"])
        self.cookie = headers["Set-Cookie"].split(";")[0]

    def test_http_login_protects_state_and_rejects_cross_origin_style_posts(self):
        self.assertEqual(self.request("GET", "/api/state")[0], 401)
        self.assertEqual(self.request("POST", "/api/login", {"password": "wrong"})[0], 401)
        self.assertEqual(self.request("POST", "/api/login", {"password": "test-password-123"}, {"X-Reels-Request": ""})[0], 403)
        self.login()
        self.assertEqual(self.request("GET", "/api/state")[0], 200)
        self.assertEqual(self.request("POST", "/api/generate", {}, {"Content-Length": str(web.MAX_BODY + 1)})[0], 413)

    def test_upload_and_saved_reference_validation(self):
        self.login()
        status, _, raw = self.request("POST", "/api/upload", {"name": "character.png", "data": base64.b64encode(b"image-fixture").decode()})
        self.assertEqual(status, 200)
        name = json.loads(raw)["reference"]
        self.assertEqual(Path(self.app.references([name])[0]).read_bytes(), b"image-fixture")
        self.assertEqual(self.request("POST", "/api/upload", {"name": "x.py", "data": ""})[0], 400)

    def test_private_media_range_head_and_path_escape(self):
        clip = self.app.workspace / "episodes" / "episode" / "scene-001.mp4"
        clip.parent.mkdir(parents=True)
        clip.write_bytes(b"0123456789")
        path = "/api/media?path=episodes/episode/scene-001.mp4"
        self.assertEqual(self.request("GET", path)[0], 401)
        self.login()
        status, headers, data = self.request("GET", path, headers={"Range": "bytes=2-5"})
        self.assertEqual((status, data), (206, b"2345"))
        self.assertEqual(headers["Content-Range"], "bytes 2-5/10")
        self.assertEqual(self.request("GET", path, headers={"Range": "bytes=-3"})[2], b"789")
        self.assertEqual(self.request("GET", path, headers={"Range": "bytes=20-"})[0], 416)
        status, headers, data = self.request("HEAD", path)
        self.assertEqual((status, data, headers["Content-Length"]), (200, b"", "10"))
        self.assertEqual(self.request("GET", "/api/media?path=../secret.mp4")[0], 400)
        secret = self.root / "secret.mp4"
        secret.write_bytes(b"private")
        (clip.parent / "link.mp4").symlink_to(secret)
        self.assertEqual(self.request("GET", "/api/media?path=episodes/episode/link.mp4")[0], 400)

    def test_static_dashboard_assets_and_no_sse_requirement(self):
        self.assertEqual(self.request("GET", "/")[0], 200)
        self.assertEqual(self.request("GET", "/app.js")[0], 200)
        script = (ROOT / "tools/colab_web_ui.js").read_text()
        self.assertNotIn("EventSource", script)
        self.assertIn("setInterval", script)

    def test_authenticated_plan_request_runs_real_background_worker(self):
        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                data = b'{"queue_running":[],"queue_pending":[]}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        self.app.url = f"http://127.0.0.1:{backend.server_port}"
        try:
            self.login()
            req = {"sources": [{"title": "Script upload", "text": (ROOT / "the-last-slice-s01e01.txt").read_text()}],
                   "settings": settings(), "references": []}
            self.assertEqual(self.request("POST", "/api/plan", req)[0], 202)
            for _ in range(100):
                if self.app.snapshot()["jobs"][0]["status"] != "running":
                    break
                time.sleep(.05)
            state = self.app.snapshot()
            self.assertEqual(state["jobs"][0]["status"], "done", state["jobs"][0]["log"])
            status, _, raw = self.request("GET", "/api/plan")
            self.assertEqual(status, 200)
            self.assertEqual(len(json.loads(raw)["plans"][0]["scenes"]), 12)
        finally:
            if self.app.current and self.app.current["status"] in web.ACTIVE:
                self.app.cancel()
            backend.shutdown()
            backend.server_close()
            thread.join()


class TunnelTest(unittest.TestCase):
    def test_quick_origin_and_named_token_never_appear_in_command_arguments(self):
        quick = tunnel.tunnel_command("/tmp/cloudflared", 7860)
        self.assertEqual(quick[-2:], ["--url", "http://127.0.0.1:7860"])
        named = tunnel.tunnel_command("/tmp/cloudflared", 7860, "private-token")
        self.assertEqual(named[-1], "run")
        self.assertNotIn("private-token", " ".join(named))

    def test_named_tunnel_requires_https_hostname_before_starting_any_process(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(tunnel.subprocess, "Popen") as spawn:
            with self.assertRaises(ValueError):
                tunnel.launch_dashboard(tmp, tmp, sys.executable, "http://127.0.0.1:8188", token="secret", public_url="http://example.com")
            spawn.assert_not_called()

    def test_browser_notebook_embeds_current_assets_and_cells_compile(self):
        notebook = json.loads((ROOT / "colab/Reels_Natok_Web_Studio.ipynb").read_text())
        with tempfile.TemporaryDirectory() as tmp:
            for cell in notebook["cells"]:
                if cell["cell_type"] != "code":
                    continue
                source = "".join(cell["source"])
                compile(source, "web-notebook", "exec")
                if source.startswith(("#@title Install helper:", "#@title Install browser asset:")):
                    exec(compile(source, "install-asset", "exec"), {"TOOLS": Path(tmp)})
            for name in ("colab_web.py", "colab_tunnel.py", "colab_web.html", "colab_web_ui.js", "colab_drama.py"):
                self.assertEqual((Path(tmp) / name).read_bytes(), (ROOT / "tools" / name).read_bytes())


if __name__ == "__main__":
    unittest.main()
