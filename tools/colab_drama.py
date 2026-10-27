"""Script -> sequential MiniMax H3 scenes -> resumable portrait episodes."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import time
import uuid

from assemble_episode import assemble, video_info
from colab_runtime import MODEL_FILES, api


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def plan_script(text, title="Episode", duration=5, context=""):
    """Each paragraph / --- block is a scene; this is not an LLM screenplay rewrite."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Script is empty")
    if len(text.encode()) > 2 * 1024 * 1024:
        raise ValueError("Script exceeds 2 MiB")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 5 <= duration <= 15:
        raise ValueError("Scene duration must be 5–15 seconds")
    text = text.replace("\r\n", "\n").strip()
    scenes = [s.strip() for s in re.split(r"\n\s*---+\s*\n|\n\s*\n", text) if s.strip()]
    if len(scenes) > 120:
        raise ValueError("Use at most 120 scenes per episode")
    for i, scene in enumerate(scenes, 1):
        if len(scene) > 2500:
            raise ValueError(f"Scene {i} is too long. Split it into short visual scenes separated by a blank line.")
    return {"title": str(title), "context": str(context),
            "scenes": [{"prompt": s, "duration": duration} for s in scenes]}


def frame_count(seconds):
    n = max(124, round(seconds * 24))
    return n + (5 - n % 17) % 17


def build_workflow(prompt, seconds, seed, prefix, references=(), width=576, height=1024, clip_device="default"):
    """Native ComfyUI nodes only; no Windows patches, custom attention or preview nodes."""
    if len(references) > 9:
        raise ValueError("At most 9 character/scene reference images are supported")
    if (width, height) not in ((576, 1024), (768, 1344)):
        raise ValueError("Choose generation preset 576x1024 or 768x1344")
    if not 5 <= seconds <= 15:
        raise ValueError("Scene duration must be 5–15 seconds")
    def node(kind, **inputs):
        return {"class_type": kind, "inputs": inputs}
    names = {k: Path(v).name for k, v in MODEL_FILES.items()}
    workflow = {
        "model": node("UNETLoader", unet_name=names["diffusion"], weight_dtype="default"),
        "clip": node("CLIPLoader", clip_name=names["clip"], type="minimax", device=clip_device),
        "video_vae": node("VAELoader", vae_name=names["video_vae"]),
        "audio_vae": node("VAELoader", vae_name=names["audio_vae"]),
        "turbo": node("LoraLoaderModelOnly", model=["model", 0], lora_name=names["turbo"], strength_model=1.0),
        "shift": node("MiniMaxH3SigmaShift", model=["turbo", 0], shift_video=12.0, shift_audio=3.0),
        "conditioning": node("MiniMaxH3ReferenceToVideo", prompt=prompt, width=width, height=height,
                             length=frame_count(seconds), ref_image_size="match", clip=["clip", 0],
                             vae=["video_vae", 0], audio_vae=["audio_vae", 0]),
        "noise": node("RandomNoise", noise_seed=seed),
        "scheduler": node("BasicScheduler", model=["shift", 0], scheduler="simple", steps=4, denoise=1.0),
        "sampler": node("KSamplerSelect", sampler_name="euler"),
        "guider": node("BasicGuider", model=["shift", 0], conditioning=["conditioning", 0]),
        "sample": node("SamplerCustomAdvanced", noise=["noise", 0], guider=["guider", 0],
                       sampler=["sampler", 0], sigmas=["scheduler", 0], latent_image=["conditioning", 1]),
        "decode_video": node("VAEDecode", samples=["sample", 0], vae=["video_vae", 0]),
        "decode_audio": node("VAEDecodeAudio", samples=["sample", 0], vae=["audio_vae", 0]),
        "video": node("CreateVideo", images=["decode_video", 0], audio=["decode_audio", 0], fps=24.0),
        "save": node("SaveVideo", video=["video", 0], filename_prefix=prefix, format="auto"),
    }
    for i, filename in enumerate(references):
        key = f"reference_{i}"
        workflow[key] = node("LoadImage", image=filename)
        workflow["conditioning"]["inputs"][f"ref_images.ref_image_{i}"] = [key, 0]
    return workflow


def check_nodes(url, workflow):
    available = api(url, "/object_info")
    missing = sorted({n["class_type"] for n in workflow.values()} - available.keys())
    if missing:
        raise RuntimeError("Required native ComfyUI nodes failed to load: " + ", ".join(missing))
    # Verify model filenames against the running backend's own file lists.
    for key, field in (("model", "unet_name"), ("clip", "clip_name"),
                       ("video_vae", "vae_name"), ("audio_vae", "vae_name"), ("turbo", "lora_name")):
        node = workflow[key]
        choices = available[node["class_type"]]["input"]["required"][field][0]
        if node["inputs"][field] not in choices:
            raise RuntimeError(f"Backend cannot find model: {node['inputs'][field]}")


def queued_prompt(url, token, include_history=False):
    queue = api(url, "/queue")
    for entry in queue.get("queue_running", []) + queue.get("queue_pending", []):
        if len(entry) > 3 and isinstance(entry[3], dict) and entry[3].get("drama_token") == token:
            return str(entry[1])
    if include_history:
        # Recover a POST accepted by ComfyUI whose response was lost before the
        # prompt ID was written locally, including a scene already completed.
        for item in api(url, "/history?max_items=200").values():
            prompt = item.get("prompt", [])
            if len(prompt) > 3 and isinstance(prompt[3], dict) and prompt[3].get("drama_token") == token:
                return str(prompt[1])
    return None


def wait_for_scene(url, prompt_id, timeout=7200):
    deadline = time.monotonic() + timeout
    last_log = 0
    failures = 0
    while time.monotonic() < deadline:
        try:
            history = api(url, f"/history/{prompt_id}").get(prompt_id)
            failures = 0
        except (OSError, RuntimeError):
            failures += 1
            if failures >= 12:
                raise RuntimeError("Backend unavailable. Rerun after reconnecting; saved scene state is retained.")
            time.sleep(5)
            continue
        if history:
            status = history.get("status", {})
            if status.get("status_str") == "error":
                messages = json.dumps(status.get("messages", []), ensure_ascii=False)
                raise RuntimeError("Scene generation failed: " + messages[-4000:])
            if status.get("completed"):
                return history
        if time.monotonic() - last_log >= 30:
            print(f"Waiting for scene {prompt_id}…", flush=True)
            last_log = time.monotonic()
        time.sleep(5)
    raise TimeoutError("Scene exceeded monitoring timeout. Its prompt ID is saved; rerun to reattach.")


def output_video(history, output_root):
    """Accept only backend output paths under the known local output directory."""
    candidates = []
    def walk(value):
        if isinstance(value, dict):
            if isinstance(value.get("filename"), str) and value.get("type") == "output":
                if Path(value["filename"]).suffix.lower() in (".mp4", ".webm", ".mov"):
                    candidates.append(value)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)
    walk(history.get("outputs", {}).get("save", {}))
    if len(candidates) != 1:
        raise RuntimeError(f"Expected one completed scene video, got {len(candidates)}")
    root = Path(output_root).resolve()
    item = candidates[0]
    path = (root / item.get("subfolder", "") / item["filename"]).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise RuntimeError("Invalid or missing backend output file")
    video_info(path)
    return path


def prepare_references(paths, comfy):
    names, hashes = [], []
    for file in paths:
        file = Path(file)
        if file.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            raise ValueError("Character references must be PNG/JPG/WebP images")
        if file.stat().st_size > 20 * 1024 * 1024:
            raise ValueError("Reference images must be under 20 MiB")
        hash_ = hashlib.sha256(file.read_bytes()).hexdigest()
        name = f"drama-ref-{hash_[:24]}{file.suffix.lower()}"
        target = Path(comfy) / "input" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copyfile(file, target)
        names.append(name)
        hashes.append(hash_)
    if len(names) > 9:
        raise ValueError("Use at most 9 reference images")
    return names, hashes


def run_episode(plan, workspace, runtime_root, url, *, references=(), seed=42,
                preset="576x1024", fit="pad", timeout=7200):
    if fit not in ("pad", "crop"):
        raise ValueError("fit must be pad or crop")
    if preset not in ("576x1024", "768x1344"):
        raise ValueError("Unknown generation preset")
    scenes = plan.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("Episode requires scenes")
    root = Path(runtime_root).resolve()
    comfy = root / "ComfyUI"
    names, hashes = prepare_references(references, comfy)
    lock = json.loads((root / "runtime-lock.json").read_text())
    stats = api(url, "/system_stats")
    large_gpu = any(d.get("vram_total", 0) >= 60 * 2**30 for d in stats.get("devices", []))
    clip_device = "default" if large_gpu else "cpu"
    recipe = {"version": 2, "language": "English", "plan": plan, "references": hashes, "seed": seed,
              "preset": preset, "fit": fit, "models": MODEL_FILES,
              "comfy_commit": lock["comfy_commit"], "model_commit": lock["model_commit"]}
    recipe_hash = digest(recipe)
    slug = re.sub(r"[^a-zA-Z0-9_-]", "-", str(plan.get("title", "episode"))).strip("-")[:48] or "episode"
    folder = Path(workspace).resolve() / "episodes" / f"{slug}-{recipe_hash[:12]}"
    folder.mkdir(parents=True, exist_ok=True)
    atomic_json(folder / "recipe.json", recipe)
    width, height = map(int, preset.split("x"))
    ordered = []
    for i, scene in enumerate(scenes):
        scene_id = digest({"recipe": recipe_hash, "scene": i})
        path = folder / f"scene-{i+1:03d}.mp4"
        state_path = folder / f"scene-{i+1:03d}.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if path.exists() and state.get("status") == "done" and state.get("fingerprint") == scene_id:
            video_info(path)
            print(f"Reuse scene {i+1}/{len(scenes)}", flush=True)
            ordered.append(path)
            continue
        prompt = (
            "Create a cinematic English-language drama scene for a vertical social video. "
            "Maintain the same characters, clothing, voices and setting described below. "
            "Natural acting, coherent motion, native synchronized dialogue and ambient sound. "
            "Spoken dialogue is English. Preserve supplied English dialogue and translate any non-English speech into natural English. "
            "No subtitles, captions, watermarks or written overlays.\n"
            f"Shared character and story context: {plan.get('context', '')}\n"
            f"Scene {i+1}: {scene['prompt']}"
        )
        workflow = build_workflow(prompt, scene["duration"], (int(seed) + i) % 2**63,
                                  f"drama/{scene_id}", names, width, height, clip_device)
        check_nodes(url, workflow)
        prompt_id = state.get("prompt_id") if state.get("fingerprint") == scene_id else None
        history = api(url, f"/history/{prompt_id}").get(prompt_id) if prompt_id else None
        queued = queued_prompt(url, scene_id, include_history=state.get("status") == "submitting")
        if history and history.get("status", {}).get("status_str") == "error":
            history = None  # A deliberate rerun may retry the failed scene once.
            prompt_id = None
        if not history and queued:
            prompt_id = queued
        elif not history:
            # A disconnected runtime may have lost its queue/history; completed
            # clips on Drive are still retained and skipped above.
            prompt_id = None
        if not prompt_id:
            atomic_json(state_path, {"fingerprint": scene_id, "status": "submitting"})
            print(f"Generate scene {i+1}/{len(scenes)} ({scene['duration']}s requested)", flush=True)
            result = api(url, "/prompt", {"prompt": workflow, "client_id": str(uuid.uuid4()),
                                         "extra_data": {"drama_token": scene_id}}, timeout=120)
            if result.get("node_errors") or not result.get("prompt_id"):
                raise RuntimeError("Workflow rejected: " + json.dumps(result, ensure_ascii=False)[:3000])
            prompt_id = result["prompt_id"]
        atomic_json(state_path, {"fingerprint": scene_id, "status": "running", "prompt_id": prompt_id})
        if not history or not history.get("status", {}).get("completed"):
            history = wait_for_scene(url, prompt_id, timeout)
        source = output_video(history, comfy / "output")
        temp = path.with_suffix(".tmp.mp4")
        shutil.copyfile(source, temp)
        os.replace(temp, path)
        atomic_json(state_path, {"fingerprint": scene_id, "status": "done", "prompt_id": prompt_id,
                                 "duration": video_info(path)[2]})
        ordered.append(path)
    manifest = {"episodes": [{"output": "episode-1080x1920.mp4", "fit": fit,
                               "clips": [p.name for p in ordered]}]}
    atomic_json(folder / "assembly.json", manifest)
    final = folder / "episode-1080x1920.mp4"
    receipt = folder / "completed.json"
    if final.exists() and receipt.exists():
        saved = json.loads(receipt.read_text())
        _, video, _ = video_info(final)
        if saved.get("recipe") == recipe_hash and (video["width"], video["height"]) == (1080, 1920):
            print("Reuse completed episode:", final)
            return final
    # Only this recipe's managed export is replaced; originals are retained.
    assemble(ordered, final, fit=fit, overwrite=True)
    atomic_json(receipt, {"recipe": recipe_hash, "output": final.name,
                          "duration": video_info(final)[2], "scene_count": len(ordered)})
    return final
