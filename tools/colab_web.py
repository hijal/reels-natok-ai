"""Authenticated browser dashboard for the existing Colab episode pipeline.

Only this HTTP server is tunneled. ComfyUI stays on loopback. Long operations run
in a child process so HTTP requests finish quickly and browser disconnects do not
cancel jobs. Recipe checkpoints remain owned by colab_drama.run_episode.
"""
import argparse
import base64
import hashlib
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

from colab_drama import atomic_json

MAX_BODY = 29 * 1024 * 1024
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
ACTIVE = {"running", "cancelling"}


def inside(root, name):
    root = Path(root).resolve()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or path == root:
        raise ValueError("Path is outside the allowed folder")
    return path


def number(value, low, high, label, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Invalid {label}")
    if not low <= value <= high or (integer and int(value) != value):
        raise ValueError(f"{label} must be between {low} and {high}")
    return value


def validate_plans(plans):
    if not isinstance(plans, list) or not 1 <= len(plans) <= 30:
        raise ValueError("Provide 1–30 episodes")
    for plan in plans:
        if not isinstance(plan, dict) or not isinstance(plan.get("title"), str) or not plan["title"].strip():
            raise ValueError("Each episode needs a title")
        if len(plan["title"]) > 300 or not isinstance(plan.get("context", ""), str) or len(plan.get("context", "")) > 32000:
            raise ValueError("Episode title or context is too long")
        scenes = plan.get("scenes")
        if not isinstance(scenes, list) or not 1 <= len(scenes) <= 120:
            raise ValueError("Each episode needs 1–120 scenes")
        for scene in scenes:
            if not isinstance(scene, dict) or not isinstance(scene.get("prompt"), str) or not scene["prompt"].strip() or len(scene["prompt"]) > 60000:
                raise ValueError("Each scene needs a nonempty prompt under 60,000 characters")
            number(scene.get("duration"), 5, 15, "scene duration")
    return plans


def worker(request_path):
    """Called by our own process manager, never directly by a web-provided command."""
    from colab_drama import run_episode, frame_count
    from colab_planner import plan_story
    from colab_drama import plan_script
    from colab_runtime import api
    from colab_finish import finish_run
    from drama_script import parse_drama_script, is_drama_script

    request_path = Path(request_path)
    req = json.loads(request_path.read_text())
    workspace, runtime = Path(req["workspace"]), Path(req["runtime"])
    settings = req["settings"]
    if req["action"] == "plan":
        queue = api(req["url"], "/queue")
        if queue.get("queue_running") or queue.get("queue_pending"):
            raise RuntimeError("Finish or cancel the current backend generation before planning.")
        api(req["url"], "/free", {"unload_models": True, "free_memory": True})
        plans = []
        for source in req["sources"]:
            print("Planning:", source["title"], flush=True)
            if is_drama_script(source["text"]) or settings["mode"] == "structured-script":
                plan = parse_drama_script(source["text"], context=settings["context"])
            elif settings["mode"] == "auto-story":
                plan = plan_story(source["text"], source["title"], settings["context"],
                                  settings["target"], settings["scene_seconds"], runtime, workspace)
            else:
                plan = plan_script(source["text"], source["title"], settings["scene_seconds"], settings["context"])
            plans.append(plan)
        validate_plans(plans)
        result = {"plans": plans, "settings": settings, "references": req["references"]}
        atomic_json(workspace / "web" / "last-plan.json", result)
        atomic_json(workspace / "runtime-lock.json", json.loads((runtime / "runtime-lock.json").read_text()))
        for p in plans:
            duration = sum(frame_count(s["duration"]) / 24 for s in p["scenes"])
            print(f"Ready for review: {p['title']}, {len(p['scenes'])} scenes, about {duration:.2f}s", flush=True)
    else:
        plans = validate_plans(req["plans"])
        if req["action"] == "test":
            plans = [dict(plans[0], title=plans[0]["title"] + "-test",
                          scenes=[dict(plans[0]["scenes"][0], duration=5)])]
            workspace = workspace / "tests"
        outputs = []
        for plan in plans:
            outputs.append(str(run_episode(plan, workspace, runtime, req["url"],
                references=req["references"], seed=settings["seed"], preset=settings["preset"], fit=settings["fit"])))
        finish_run(outputs, workspace, len(plans), auto_disconnect=False)
        result = {"outputs": outputs, "test": req["action"] == "test"}
    atomic_json(request_path.parent / "result.json", result)


class Dashboard:
    def __init__(self, workspace, runtime, url, password):
        if len(password) < 12:
            raise ValueError("Use a dashboard password of at least 12 characters")
        parsed = urlsplit(url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
            raise ValueError("ComfyUI must use a loopback HTTP address")
        self.workspace, self.runtime = Path(workspace).resolve(), Path(runtime).resolve()
        self.folder = self.workspace / "web"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.url, self.password = url, hashlib.sha256(password.encode()).digest()
        self.session = secrets.token_urlsafe(32)
        self.boot_id = os.environ.get("REELS_WEB_BOOT_ID", "")
        self.lock = threading.RLock()
        self.process = None
        self.current = None
        self.jobs = []
        self.login_attempts = []
        self.releasing = False
        (self.runtime / "web-release.json").unlink(missing_ok=True)
        for path in sorted(self.folder.glob("jobs/*/job.json")):
            try:
                job = json.loads(path.read_text())
                if job["status"] in ACTIVE:
                    job.update(status="interrupted", error="Dashboard restarted. Use the saved plan and resume; scene checkpoints remain.")
                    atomic_json(path, job)
                self.jobs.append(job)
            except (ValueError, OSError, KeyError):
                continue
        self.jobs = sorted(self.jobs, key=lambda j: j["created"])[-30:]

    def login(self, password):
        with self.lock:
            now = time.monotonic()
            self.login_attempts = [t for t in self.login_attempts if now - t < 60]
            if len(self.login_attempts) >= 20:
                raise ValueError("Too many login attempts. Wait one minute.")
            self.login_attempts.append(now)
            return secrets.compare_digest(hashlib.sha256(password.encode()).digest(), self.password)

    def save_job(self, job):
        atomic_json(self.folder / "jobs" / job["id"] / "job.json", job)

    def references(self, names):
        if not isinstance(names, list) or len(names) > 9:
            raise ValueError("Use at most nine reference images")
        result = []
        for name in names:
            if not isinstance(name, str):
                raise ValueError("Invalid reference")
            p = inside(self.workspace / "references", name)
            if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
                raise ValueError("Reference image not found; upload it again")
            result.append(str(p))
        return result

    def submit(self, action, body):
        if action not in {"plan", "generate", "test"}:
            raise ValueError("Unknown action")
        settings = body.get("settings", {})
        if not isinstance(settings, dict):
            raise ValueError("Invalid settings")
        settings = dict(settings)
        if settings.get("preset") not in {"576x1024", "768x1344"} or settings.get("fit") not in {"pad", "crop"}:
            raise ValueError("Select a supported resolution and fit")
        number(settings.get("seed"), 0, 2**63 - 1, "seed", integer=True)
        references = self.references(body.get("references", []))
        req = {"action": action, "workspace": str(self.workspace), "runtime": str(self.runtime),
               "url": self.url, "settings": settings, "references": references}
        if action == "plan":
            if settings.get("mode") not in {"auto-story", "scene-paragraphs", "structured-script"}:
                raise ValueError("Unknown script mode")
            number(settings.get("target"), 5, 120, "target duration")
            number(settings.get("scene_seconds"), 5, 15, "preferred scene duration")
            if not isinstance(settings.get("context"), str) or len(settings["context"]) > 16000:
                raise ValueError("Shared context must be under 16,000 characters")
            sources = body.get("sources")
            if not isinstance(sources, list) or not 1 <= len(sources) <= 30:
                raise ValueError("Enter a story or upload 1–30 scripts")
            for item in sources:
                if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip() or len(item["text"].encode()) > 2 * 1024 * 1024:
                    raise ValueError("Each script must contain text under 2 MiB")
                if not isinstance(item.get("title"), str) or not item["title"].strip() or len(item["title"]) > 300:
                    raise ValueError("Each story needs a title under 300 characters")
            req["sources"] = sources
        else:
            req["plans"] = validate_plans(body.get("plans"))
        with self.lock:
            if self.releasing or (self.current and self.current["status"] in ACTIVE):
                raise ValueError("Another job is active; wait or cancel it first")
            id_ = secrets.token_hex(12)
            folder = self.folder / "jobs" / id_
            atomic_json(folder / "request.json", req)
            if action != "plan":
                atomic_json(self.folder / "last-plan.json", {"plans": req["plans"], "settings": settings, "references": references})
            job = {"id": id_, "action": action, "status": "running", "created": time.time(), "error": None}
            self.save_job(job)
            env = {k: v for k, v in os.environ.items() if k not in {"REELS_WEB_PASSWORD", "TUNNEL_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN"}}
            try:
                with (folder / "output.log").open("wb") as log:
                    self.process = subprocess.Popen([sys.executable, "-u", __file__, "--worker", str(folder / "request.json")],
                        stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            except OSError as exc:
                job.update(status="error", error=str(exc))
                self.save_job(job)
                raise ValueError("Could not launch the background worker") from exc
            self.current = job
            self.jobs = (self.jobs + [job])[-30:]
            threading.Thread(target=self.monitor, args=(job, self.process), daemon=True).start()
            return job

    def monitor(self, job, process):
        code = process.wait()
        with self.lock:
            if job["status"] == "running":
                result = self.folder / "jobs" / job["id"] / "result.json"
                job["status"] = "done" if code == 0 and result.is_file() else "error"
                if job["status"] == "error":
                    job["error"] = "Job failed. Inspect its log; completed scene checkpoints are retained."
                elif job["action"] == "generate":
                    atomic_json(self.folder / "last-generation.json", {**json.loads(result.read_text()), "job_id": job["id"]})
            elif job["status"] == "cancelling":
                return  # cancel() owns the terminal transition, including ComfyUI interruption.
            self.save_job(job)

    def cancel(self):
        from colab_runtime import api
        with self.lock:
            if not self.current or self.current["status"] not in ACTIVE:
                return
            job, process = self.current, self.process
            job["status"] = "cancelling"
            self.save_job(job)
        # Stop the worker before touching the queue so it cannot submit another scene.
        # The planner is a grandchild and may own GPU memory. Stop the entire
        # process group created for this worker, without touching other jobs.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        try:
            # Only interrupt jobs tagged with our persisted scene fingerprints.
            tokens = set()
            for base in (self.workspace / "episodes", self.workspace / "tests" / "episodes"):
                for state in base.glob("*/scene-*.json"):
                    try:
                        tokens.add(json.loads(state.read_text()).get("fingerprint"))
                    except (OSError, ValueError):
                        pass
            queue = api(self.url, "/queue")
            def owned(entry):
                return len(entry) > 3 and isinstance(entry[3], dict) and entry[3].get("drama_token") in tokens
            pending = [e[1] for e in queue.get("queue_pending", []) if owned(e)]
            if pending:
                api(self.url, "/queue", {"delete": pending})
            if any(owned(e) for e in queue.get("queue_running", [])):
                api(self.url, "/interrupt", {})
            status, error = "cancelled", None
        except (OSError, RuntimeError) as exc:
            status, error = "error", f"Worker stopped; backend interruption could not be confirmed: {exc}"
        with self.lock:
            job.update(status=status, error=error)
            self.save_job(job)

    def snapshot(self):
        with self.lock:
            jobs = []
            for job in reversed(self.jobs):
                item = dict(job)
                folder = self.folder / "jobs" / job["id"]
                try:
                    with (folder / "output.log").open("rb") as log:
                        log.seek(0, 2)
                        log.seek(max(0, log.tell() - 20000))
                        item["log"] = log.read().decode("utf-8", "replace")
                except OSError:
                    item["log"] = ""
                jobs.append(item)
            videos = []
            for base in (self.workspace / "episodes", self.workspace / "tests" / "episodes"):
                for p in base.glob("*/*.mp4"):
                    if p.name.endswith(".tmp.mp4"):
                        continue
                    videos.append({"path": str(p.relative_to(self.workspace)), "name": p.name,
                                   "episode": p.parent.name, "mtime": p.stat().st_mtime})
            return {"jobs": jobs, "videos": sorted(videos, key=lambda v: v["mtime"], reverse=True)[:120],
                    "busy": bool(self.current and self.current["status"] in ACTIVE), "releasing": self.releasing}

    def release(self):
        from colab_finish import finish_run
        with self.lock:
            if self.current and self.current["status"] in ACTIVE:
                raise ValueError("Finish or cancel the active job before releasing the GPU")
            # Verification failures leave both server and runtime assigned.
            output = self.folder / "last-generation.json"
            if not output.is_file():
                raise ValueError("Generate a complete episode batch before using verified GPU release")
            outputs = json.loads(output.read_text())["outputs"]
            latest_generation = next((j for j in reversed(self.jobs) if j["action"] == "generate"), None)
            if not latest_generation or latest_generation["status"] != "done":
                raise ValueError("The most recent episode batch has not completed successfully")
            finish_run(outputs, self.workspace, len(outputs), auto_disconnect=False)
            atomic_json(self.runtime / "web-release.json", {"outputs": outputs})
            self.releasing = True


class Handler(BaseHTTPRequestHandler):
    server_version = "ReelsDashboard"

    def log_message(self, *_args):
        pass  # Do not put passwords, media paths or cookies in access logs.

    @property
    def app(self):
        return self.server.app

    def reply(self, status, payload, content_type="application/json", extra=None):
        data = json.dumps(payload).encode() if content_type == "application/json" else payload
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def authenticated(self):
        try:
            jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
            return "reels_session" in jar and secrets.compare_digest(jar["reels_session"].value, self.app.session)
        except (cookies.CookieError, TypeError):
            return False

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            if url.path == "/":
                return self.reply(200, Path(__file__).with_suffix(".html").read_bytes(), "text/html; charset=utf-8")
            if url.path == "/app.js":
                return self.reply(200, Path(__file__).with_name("colab_web_ui.js").read_bytes(), "text/javascript; charset=utf-8")
            if url.path == "/health":
                return self.reply(200, {"ok": True, "boot_id": self.app.boot_id})
            if not self.authenticated():
                return self.reply(401, {"error": "Sign in with the password shown in Colab"})
            if url.path == "/api/state":
                return self.reply(200, self.app.snapshot())
            if url.path == "/api/plan":
                p = self.app.folder / "last-plan.json"
                data = json.loads(p.read_text()) if p.is_file() else {"plans": []}
                data["references"] = [Path(p).name for p in data.get("references", [])]
                return self.reply(200, data)
            if url.path == "/api/media":
                return self.media(parse_qs(url.query))
            return self.reply(404, {"error": "Not found"})
        except (OSError, ValueError) as exc:
            return self.reply(400, {"error": str(exc)})

    def media(self, query):
        path = inside(self.app.workspace, query.get("path", [""])[0])
        relative = path.relative_to(self.app.workspace)
        if relative.parts[0] not in {"episodes", "tests"} or path.suffix != ".mp4" or not path.is_file() or path.name.endswith(".tmp.mp4"):
            return self.reply(404, {"error": "Video not found"})
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_ = self.headers.get("Range")
        if range_:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", range_)
            if not m or not any(m.groups()):
                return self.reply(416, {"error": "Invalid range"}, extra={"Content-Range": f"bytes */{size}"})
            if not m[1]:
                start = max(0, size - int(m[2]))
            else:
                start = int(m[1])
                end = min(size - 1, int(m[2])) if m[2] else size - 1
            if start > end or start >= size:
                return self.reply(416, {"error": "Invalid range"}, extra={"Content-Range": f"bytes */{size}"})
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if query.get("download") == ["1"]:
            self.send_header("Content-Disposition", 'attachment; filename="' + path.name + '"')
        self.end_headers()
        if self.command != "HEAD":
            with path.open("rb") as source:
                source.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

    def do_POST(self):
        try:
            # Custom header + no CORS support prevents browser cross-origin POSTs.
            if self.headers.get("X-Reels-Request") != "1":
                return self.reply(403, {"error": "Use the dashboard to submit requests"})
            action = urlsplit(self.path).path
            if action != "/api/login" and not self.authenticated():
                return self.reply(401, {"error": "Sign in again"})
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                return self.reply(415, {"error": "JSON required"})
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= MAX_BODY:
                return self.reply(413, {"error": "Request too large or empty"})
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object")
            if action == "/api/login":
                password = body.get("password", "")
                if not isinstance(password, str) or not self.app.login(password):
                    return self.reply(401, {"error": "Incorrect password"})
                secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
                return self.reply(200, {"ok": True}, extra={"Set-Cookie": f"reels_session={self.app.session}; HttpOnly; SameSite=Strict; Path=/{secure}"})
            if action == "/api/logout":
                return self.reply(200, {"ok": True}, extra={"Set-Cookie": "reels_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"})
            if action == "/api/upload":
                ext = Path(str(body.get("name", ""))).suffix.lower()
                if ext not in IMAGE_EXTS:
                    raise ValueError("Upload a PNG, JPG or WebP image")
                data = base64.b64decode(body.get("data", ""), validate=True)
                if not 0 < len(data) <= 20 * 1024 * 1024:
                    raise ValueError("Reference image must be under 20 MiB")
                name = hashlib.sha256(data).hexdigest()[:24] + ext
                target = self.app.workspace / "references" / name
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(data)
                return self.reply(200, {"reference": name})
            if action in {"/api/plan", "/api/generate", "/api/test"}:
                return self.reply(202, self.app.submit(action.rsplit("/", 1)[1], body))
            if action == "/api/cancel":
                self.app.cancel()
                return self.reply(200, {"ok": True})
            if action == "/api/release":
                self.app.release()
                return self.reply(200, {"ok": True})
            return self.reply(404, {"error": "Not found"})
        except (ValueError, TypeError, KeyError, OSError, RuntimeError) as exc:
            return self.reply(400, {"error": str(exc)})


def serve(workspace, runtime, url, password, port=7860):
    app = Dashboard(workspace, runtime, url, password)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.app = app
    def stop(_signum, _frame):
        app.cancel()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    print(f"Dashboard ready on loopback port {port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path)
    parser.add_argument("--workspace", type=Path)
    parser.add_argument("--runtime", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8188")
    parser.add_argument("--port", type=int, default=7860)
    args = parser.parse_args()
    if args.worker:
        worker(args.worker)
    else:
        if not args.workspace or not args.runtime:
            parser.error("--workspace and --runtime are required")
        serve(args.workspace, args.runtime, args.url, os.environ.get("REELS_WEB_PASSWORD", ""), args.port)
