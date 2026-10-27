"""Exercise planning, workflow contracts and interrupted-run recovery without a GPU."""
import json
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import colab_drama as drama
from colab_runtime import MODEL_FILES, require_runtime, api
from colab_planner import decode_plan, scene_schedule


class PlanningTest(unittest.TestCase):
    def test_auto_story_schedule_and_strict_json_validation(self):
        self.assertEqual(scene_schedule(60, 5), (12, 5))
        self.assertEqual(scene_schedule(120, 10), (12, 10))
        raw = json.dumps({'context': 'Same mother and son',
                          'scenes': [{'prompt': f'Scene {i}'} for i in range(12)]})
        plan = decode_plan('```json\n' + raw + '\n```', 'Episode', 'User identity', 60, 5)
        self.assertEqual(len(plan['scenes']), 12)
        self.assertTrue(all(s['duration'] == 5 for s in plan['scenes']))
        self.assertIn('User identity', plan['context'])
        for invalid in ('not json', '{"scenes":[]}', '{"scenes":"bad"}'):
            with self.assertRaises(ValueError):
                decode_plan(invalid, 'Episode', '', 60, 5)

    def test_bengali_script_preserves_dialogue_and_scene_order(self):
        script = 'মা বলেন, "কোথায় যাচ্ছিস?"\r\n\r\nছেলে ফিরে তাকায়।\n---\nতারা বিদায় জানায়।'
        plan = drama.plan_script(script, "Episode 1", 5, "Same mother and son")
        self.assertEqual(len(plan["scenes"]), 3)
        self.assertEqual(plan["scenes"][1]["prompt"], "ছেলে ফিরে তাকায়।")
        self.assertIn('"কোথায় যাচ্ছিস?"', plan["scenes"][0]["prompt"])
        self.assertEqual(drama.frame_count(5), 124)
        self.assertTrue(all(drama.frame_count(n) % 17 == 5 for n in (5, 10, 15)))

    def test_invalid_inputs_and_low_resource_runtime_fail_early(self):
        for script, duration in (("", 5), ("scene", 120), ("scene", float("nan")), ("scene", True)):
            with self.assertRaises(ValueError):
                drama.plan_script(script, duration=duration)
        with self.assertRaises(RuntimeError):
            require_runtime({"cuda_available": True, "cuda_kernel_test": True,
                             "capability": [7, 5], "vram_gib": 15, "available_ram_gib": 12})
        require_runtime({"cuda_available": True, "cuda_kernel_test": True,
                         "capability": [12, 0], "vram_gib": 96, "available_ram_gib": 170})

    def test_native_graph_links_models_references_audio_and_shift(self):
        w = drama.build_workflow("test", 5, 42, "test-output", ["mother.png", "son.png"])
        self.assertEqual(w["conditioning"]["inputs"]["ref_images.ref_image_0"], ["reference_0", 0])
        self.assertEqual(w["conditioning"]["inputs"]["length"], 124)
        self.assertEqual(w["scheduler"]["inputs"]["model"], ["shift", 0])
        self.assertEqual(w["video"]["inputs"]["audio"], ["decode_audio", 0])
        self.assertEqual(w["model"]["inputs"]["unet_name"], Path(MODEL_FILES["diffusion"]).name)
        for node in w.values():
            for value in node["inputs"].values():
                if isinstance(value, list):
                    self.assertIn(value[0], w)
        self.assertFalse(any("Preview" in n["class_type"] or "Sparse" in n["class_type"] for n in w.values()))


class ResumeTest(unittest.TestCase):
    def test_empty_backend_control_response_is_successful(self):
        with patch('colab_runtime.urllib.request.urlopen', return_value=io.BytesIO(b'')):
            self.assertEqual(api('http://fake', '/free', {'unload_models': True}), {})

    def test_lost_submit_response_recovers_a_finished_prompt(self):
        def response(url, path):
            if path == '/queue':
                return {}
            return {'p1': {'prompt': [1, 'p1', {}, {'drama_token': 'scene-token'}]}}
        with patch.object(drama, 'api', side_effect=response):
            self.assertEqual(drama.queued_prompt('http://fake', 'scene-token', include_history=True), 'p1')

    def test_interrupted_episode_reuses_first_scene_and_attaches_second_prompt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "runtime-lock.json").write_text(json.dumps({"comfy_commit": "abc", "model_commit": "def"}))
            backend = runtime / "ComfyUI/output"
            backend.mkdir(parents=True)
            (backend / "clip.mp4").write_bytes(b"fake video fixture")
            plan = drama.plan_script("First scene\n\nSecond scene", "Episode 1")
            submissions, attached, assembled = [], [], []
            failed = [False]
            def api(url, path, data=None, timeout=30):
                if path == "/system_stats":
                    return {"devices": [{"vram_total": 96 * 2**30}]}
                if path == "/queue":
                    if len(submissions) == 2 and not failed[0]:
                        return {"queue_running": [[0, "p2", {}, {"drama_token": submissions[1]}]]}
                    return {}
                if path == "/prompt":
                    prompt = data["prompt"]["conditioning"]["inputs"]["prompt"]
                    self.assertIn("Spoken dialogue is English.", prompt)
                    self.assertNotIn("Spoken dialogue is Bengali.", prompt)
                    submissions.append(data["extra_data"]["drama_token"])
                    return {"prompt_id": f"p{len(submissions)}"}
                if path.startswith("/history/"):
                    return {}
                raise AssertionError(path)
            def wait(url, prompt_id, timeout):
                attached.append(prompt_id)
                if prompt_id == "p2" and not failed[0]:
                    failed[0] = True
                    raise TimeoutError("Simulated notebook disconnection")
                return {"status": {"completed": True}, "outputs": {"save": {
                    "images": [{"filename": "clip.mp4", "subfolder": "", "type": "output"}]}}}
            def assemble(paths, output, **kwargs):
                assembled.append([p.name for p in paths])
                output.write_bytes(b"assembled fixture")
            info = ({"streams": [{"codec_type": "audio"}]}, {"width": 1080, "height": 1920}, 5.167)
            with patch.object(drama, "api", side_effect=api), \
                 patch.object(drama, "check_nodes"), \
                 patch.object(drama, "wait_for_scene", side_effect=wait), \
                 patch.object(drama, "video_info", return_value=info), \
                 patch.object(drama, "assemble", side_effect=assemble):
                with self.assertRaises(TimeoutError):
                    drama.run_episode(plan, root / "drive", runtime, "http://fake")
                # The second prompt is still running remotely after monitoring stopped.
                def queue_resume(url, token, include_history=False):
                    return "p2" if token == submissions[1] else None
                with patch.object(drama, "queued_prompt", side_effect=queue_resume):
                    output = drama.run_episode(plan, root / "drive", runtime, "http://fake")
                self.assertTrue(output.exists())
                self.assertEqual(len(submissions), 2)
                self.assertEqual(attached, ["p1", "p2", "p2"])
                self.assertEqual(assembled, [["scene-001.mp4", "scene-002.mp4"]])
                drama.run_episode(plan, root / "drive", runtime, "http://fake")
                self.assertEqual(len(submissions), 2)
                self.assertEqual(len(assembled), 1)

    def test_backend_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            history = {"outputs": {"save": {"images": [
                {"filename": "../private.mp4", "type": "output"}]}}}
            with self.assertRaises(RuntimeError):
                drama.output_video(history, tmp)


class NotebookTest(unittest.TestCase):
    def test_notebook_embeds_current_helpers_and_all_python_cells_compile(self):
        root = Path(__file__).resolve().parents[1]
        notebook = json.loads((root / "colab/Reels_Natok_MiniMax_H3.ipynb").read_text())
        code_cells = ["".join(c["source"]) for c in notebook["cells"] if c["cell_type"] == "code"]
        for i, source in enumerate(code_cells):
            compile(source, f"cell-{i}", "exec")
        # Only execute the three source-writing cells in a temporary directory.
        with tempfile.TemporaryDirectory() as tmp:
            for source in code_cells:
                if source.startswith("#@title Install helper:"):
                    exec(compile(source, "helper-cell", "exec"), {"TOOLS": Path(tmp)})
            for name in ("assemble_episode.py", "colab_runtime.py", "colab_drama.py", "colab_planner.py", "drama_script.py", "colab_finish.py"):
                self.assertEqual((Path(tmp) / name).read_text(), (root / "tools" / name).read_text())


if __name__ == "__main__":
    unittest.main()
