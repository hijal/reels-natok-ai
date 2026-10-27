"""Notebook-first Linux setup for native MiniMax H3 ComfyUI inference."""
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

MODEL_REPO = "Comfy-Org/MiniMax-H3"
# FP8-scaled + FP16 VAE avoids requiring the Windows CUDA 13 INT8 stack.
MODEL_FILES = {
    "diffusion": "diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors",
    "clip": "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "video_vae": "vae/minimax_h3_video_vae_fp16.safetensors",
    "audio_vae": "vae/minimax_h3_audio_vae_fp32.safetensors",
    "turbo": "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
}


def command(args, **kwargs):
    display = list(map(str, args))
    if "-c" in display:
        display = display[:display.index("-c") + 1] + ["<Python setup code>"]
    print("Running:", " ".join(display), flush=True)
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def runtime_report():
    import torch
    import psutil
    report = {
        "python": sys.version.split()[0], "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "ram_gib": round(psutil.virtual_memory().total / 2**30, 1),
        "available_ram_gib": round(psutil.virtual_memory().available / 2**30, 1),
        "disk_free_gib": round(shutil.disk_usage("/content" if Path("/content").exists() else ".").free / 2**30, 1),
        "cuda_available": torch.cuda.is_available(),
    }
    if report["cuda_available"]:
        p = torch.cuda.get_device_properties(0)
        report.update(gpu=p.name, vram_gib=round(p.total_memory / 2**30, 1),
                      capability=list(torch.cuda.get_device_capability(0)))
        try:
            x = torch.ones((8, 8), device="cuda")
            _ = x @ x
            torch.cuda.synchronize()
            del x, _
            report["cuda_kernel_test"] = True
        except RuntimeError as exc:
            report["cuda_kernel_test"] = False
            report["cuda_kernel_error"] = str(exc)
    print(json.dumps(report, indent=2))
    return report


def require_runtime(report):
    """Conservative admission policy, not a guarantee of memory sufficiency."""
    problems = []
    if not report.get("cuda_available"):
        problems.append("Select a GPU runtime in Runtime > Change runtime type.")
    else:
        if not report.get("cuda_kernel_test", False):
            problems.append("The runtime's PyTorch cannot execute a CUDA kernel on this GPU. Select a compatible Colab runtime version.")
        if report.get("capability", [0])[0] < 8:
            problems.append("This notebook targets Ampere or newer (L4/A100 or better); T4 is not validated.")
        if report.get("vram_gib", 0) < 22:
            problems.append("This configuration requires at least 22 GiB reported VRAM (24 GB class GPU).")
    if report.get("available_ram_gib", 0) < 45:
        problems.append("Use a High-RAM runtime: at least 45 GiB available host RAM; 64+ GiB is preferable.")
    if problems:
        raise RuntimeError("\n".join(problems) + "\nNo models have been downloaded. These checks do not guarantee inference will fit.")


def install_runtime(root, revision="master"):
    """Install in an isolated venv, retaining the runtime's working CUDA PyTorch."""
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    comfy = root / "ComfyUI"
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        command(["apt-get", "update", "-qq"])
        command(["apt-get", "install", "-y", "-qq", "ffmpeg"])
    lock = root / "runtime-lock.json"
    if not comfy.exists():
        command(["git", "clone", "--filter=blob:none", "https://github.com/Comfy-Org/ComfyUI.git", comfy])
    saved = json.loads(lock.read_text()) if lock.exists() else {}
    ref = saved.get("comfy_commit", revision)
    command(["git", "-C", comfy, "checkout", "--detach", ref])
    sha = subprocess.check_output(["git", "-C", str(comfy), "rev-parse", "HEAD"], text=True).strip()
    venv = root / "venv"
    if not (venv / "bin/python").exists():
        command([sys.executable, "-m", "pip", "install", "virtualenv"])
        command([sys.executable, "-m", "virtualenv", "--system-site-packages", venv])
    constraints = root / "torch-constraints.txt"
    constraints.write_text("\n".join(
        f"{name}=={importlib.metadata.version(name)}"
        for name in ("torch", "torchvision", "torchaudio")
        if importlib.util.find_spec(name) is not None
    ) + "\n")
    python = venv / "bin/python"
    command([python, "-m", "pip", "install", "--upgrade", "pip"])
    command([python, "-m", "pip", "install", "-c", constraints,
             "-r", comfy / "requirements.txt", "huggingface_hub", "accelerate"])
    command([python, "-c", "import torch; assert torch.cuda.is_available(); print(torch.__version__, torch.cuda.get_device_name(0))"])
    saved["comfy_commit"] = sha
    lock.write_text(json.dumps(saved, indent=2))
    print("ComfyUI revision:", sha, "(retained on reruns)")
    return comfy, python


def download_models(root, token=None):
    """Resolve exact HF commit and check disk before transferring model weights."""
    root = Path(root).resolve()
    python = root / "venv/bin/python"
    # Run the HF library inside the venv; tokens never appear in command arguments.
    script = '''
import json, os, shutil
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download
root = Path(os.environ['DRAMA_RUNTIME_ROOT'])
lock_path = root / 'runtime-lock.json'
lock = json.loads(lock_path.read_text())
files = json.loads(os.environ['DRAMA_MODEL_FILES'])
token = os.environ.get('HF_TOKEN') or None
info = HfApi().model_info(os.environ['DRAMA_MODEL_REPO'], revision=lock.get('model_commit', 'main'), files_metadata=True, token=token)
sizes = {f.rfilename: f.size for f in info.siblings}
missing = [f for f in files if not sizes.get(f)]
if missing:
    raise RuntimeError('Required model files missing from upstream: ' + repr(missing))
target = root / 'ComfyUI/models'
target.mkdir(parents=True, exist_ok=True)
needed = sum(sizes[f] for f in files if not (target / f).exists() or (target / f).stat().st_size != sizes[f])
free = shutil.disk_usage(target).free
print(f'Models: {sum(sizes[f] for f in files) / 1e9:.1f} GB; remaining download: {needed / 1e9:.1f} GB; free disk: {free / 1e9:.1f} GB', flush=True)
if free < needed + 15 * 2**30:
    raise RuntimeError('Insufficient disk space: reserve 15 GiB beyond the remaining model downloads.')
lock['model_commit'] = info.sha
lock['model_files'] = {f: sizes[f] for f in files}
lock_path.write_text(json.dumps(lock, indent=2))
snapshot_download(os.environ['DRAMA_MODEL_REPO'], revision=info.sha, allow_patterns=files, local_dir=target, token=token)
for f in files:
    if (target / f).stat().st_size != sizes[f]:
        raise RuntimeError('Incomplete model: ' + f)
print('All required model files verified by size.', flush=True)
'''
    env = {**os.environ, "DRAMA_RUNTIME_ROOT": str(root),
           "DRAMA_MODEL_REPO": MODEL_REPO, "DRAMA_MODEL_FILES": json.dumps(list(MODEL_FILES.values()))}
    if token:
        env["HF_TOKEN"] = token
    command([python, "-c", script], env=env)


def api(url, path, data=None, timeout=30):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(url.rstrip("/") + path, body,
                                 {"Content-Type": "application/json"} if body else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            payload = response.read()
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"ComfyUI {exc.code}: {exc.read().decode(errors='replace')[:3000]}") from exc


def start_backend(root, port=8188):
    root = Path(root).resolve()
    url = f"http://127.0.0.1:{int(port)}"
    try:
        api(url, "/system_stats", timeout=2)
    except (OSError, RuntimeError):
        log_path = root / "comfy.log"
        import torch
        large_gpu = torch.cuda.get_device_properties(0).total_memory >= 60 * 2**30
        memory_flags = [] if large_gpu else ["--lowvram"]
        with log_path.open("ab") as log:
            proc = subprocess.Popen([
                str(root / "venv/bin/python"), str(root / "ComfyUI/main.py"),
                "--listen", "127.0.0.1", "--port", str(port), "--disable-auto-launch",
                *memory_flags, "--use-pytorch-cross-attention", "--preview-method", "none",
                "--disable-metadata",
            ], cwd=root / "ComfyUI", stdout=log, stderr=subprocess.STDOUT)
        for _ in range(180):
            if proc.poll() is not None:
                raise RuntimeError("ComfyUI exited:\n" + log_path.read_text(errors="replace")[-6000:])
            try:
                api(url, "/system_stats", timeout=2)
                break
            except (OSError, RuntimeError):
                time.sleep(2)
        else:
            proc.terminate()
            raise RuntimeError(f"Backend startup timed out. Inspect {log_path}")
    print("Backend ready on", url, "(not publicly exposed)")
    return url
