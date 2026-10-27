"""Release the Colab runtime only after completed episodes are verified and synced."""
import json
from pathlib import Path
import subprocess

from assemble_episode import video_info
from colab_drama import atomic_json, digest


def drive_is_mounted(root):
    """Check the same DriveFS type used by google.colab.drive.flush_and_unmount."""
    mounts = subprocess.check_output(["/bin/mount"], text=True)
    return any(f" on {Path(root).resolve()} " in line and "type fuse.drive" in line
               for line in mounts.splitlines())


def finish_run(outputs, workspace, expected_episodes, *, auto_disconnect=True,
               drive_root="/content/drive", mounted_fn=None, flush_fn=None, unassign_fn=None):
    """Call once after the entire generation loop, never from a finally block.

    Injected callbacks support CPU tests; real Colab callbacks are imported only
    when disconnection is enabled. A validation or Drive sync error leaves the
    runtime assigned. The browser tab is not closed.
    """
    paths = [Path(p).resolve() for p in outputs]
    workspace = Path(workspace).resolve()
    if expected_episodes < 1 or len(paths) != expected_episodes:
        raise RuntimeError("Not all requested episodes completed; automatic disconnect was skipped.")
    exports = []
    for output in paths:
        if not output.is_relative_to(workspace) or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError(f"Missing or out-of-workspace export; runtime kept running: {output}")
        folder = output.parent
        try:
            receipt = json.loads((folder / "completed.json").read_text(encoding="utf-8"))
            recipe = json.loads((folder / "recipe.json").read_text(encoding="utf-8"))
            count = len(recipe["plan"]["scenes"])
            recipe_hash = digest(recipe)
            if not count or receipt["scene_count"] != count or receipt["recipe"] != recipe_hash or receipt["output"] != output.name:
                raise ValueError("Completion receipt does not match the recipe")
            for i in range(count):
                clip = folder / f"scene-{i+1:03d}.mp4"
                state = json.loads((folder / f"scene-{i+1:03d}.json").read_text(encoding="utf-8"))
                if not clip.is_file() or not clip.stat().st_size or state.get("status") != "done":
                    raise ValueError(f"Scene {i+1} has not been saved completely")
                if state.get("fingerprint") != digest({"recipe": recipe_hash, "scene": i}):
                    raise ValueError(f"Scene {i+1} checkpoint does not match the recipe")
            data, video, duration = video_info(output)
            if (video["width"], video["height"]) != (1080, 1920):
                raise ValueError("Final resolution is not 1080x1920")
            if not any(s["codec_type"] == "audio" for s in data["streams"]):
                raise ValueError("Final export has no audio stream")
        except (OSError, KeyError, TypeError, ValueError, RuntimeError) as exc:
            raise RuntimeError(f"Export verification failed; runtime kept running: {output}\n{exc}") from exc
        exports.append({"path": str(output.relative_to(workspace)), "bytes": output.stat().st_size,
                        "duration": duration, "scene_count": count, "recipe": recipe_hash})
    manifest = {"complete": True, "episode_count": expected_episodes,
                "auto_disconnect_enabled": bool(auto_disconnect), "outputs": exports}
    atomic_json(workspace / "last-results.json", manifest)
    print(f"All {expected_episodes} episode(s) verified. Results list: {workspace / 'last-results.json'}", flush=True)
    for output in paths:
        print("Saved episode:", output, flush=True)
    print("Open Google Drive → My Drive → reels-natok-ai → episodes to preview/download your videos.", flush=True)
    if not auto_disconnect:
        print("AUTO_DISCONNECT is off. Runtime remains connected for notebook preview.", flush=True)
        return manifest
    if not workspace.is_relative_to(Path(drive_root).resolve()) or not (mounted_fn or drive_is_mounted)(drive_root):
        raise RuntimeError("A mounted Google Drive is required before auto-disconnect. Runtime kept running.")
    if flush_fn is None:
        from google.colab import drive
        flush_fn = lambda: drive.flush_and_unmount(timeout_ms=120_000)
    if unassign_fn is None:
        from google.colab import runtime
        unassign_fn = runtime.unassign
    print("Flushing completed videos and checkpoints to Google Drive before releasing the GPU…", flush=True)
    try:
        flush_fn()
    except Exception as exc:
        raise RuntimeError("Drive sync failed; automatic disconnect was skipped. Keep the runtime connected and retry syncing.") from exc
    print("Drive sync complete. Requesting Colab runtime shutdown and GPU release now.", flush=True)
    try:
        unassign_fn()
    except Exception as exc:
        raise RuntimeError("Videos were synced, but Colab could not release the runtime automatically. Use Runtime → Disconnect and delete runtime.") from exc
    return manifest
