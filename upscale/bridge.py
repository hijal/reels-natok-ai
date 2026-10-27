#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MiniMax Studio — Upscale bridge (fix 74).

Headless JSON-over-HTTP bridge over the DLSS 5 Visual Enhancer pipelines
(Neural Rendering, RTX Video Super Resolution, Frame Interpolation).
Replaces the Gradio app for our native UI: the Next.js backend spawns
this process with the embedded Python (upscale/bin/python-…-embed-amd64)
and talks to it on 127.0.0.1 — the browser never touches this port.

Endpoints
  GET  /health                -> {ok, ready, error, gpus:[...], output_dir, fi:{available,...}}
  GET  /schema                -> feature catalog (defaults + choices)
  POST /render                -> {jobId}   body: {feature, input, options}
                                 409 while another render holds the GPU slot
  GET  /jobs                  -> list of recent jobs
  GET  /jobs/<id>             -> {status, progress, message, output, error}
  POST /jobs/<id>/cancel      -> {ok, message}
  POST /probe                 -> media metadata {input, kind, ...}
                                 body: {input}  (video: ffprobe, image: Pillow)

Environment
  UPSCALE_BRIDGE_PORT   bridge port (default 7890)
  UPSCALE_OUTPUT_DIR    where rendered files are published (default <upscale>/outputs)

Design notes
  * stdlib only (http.server) — the bridge must run inside the embedded
    Python distribution without any extra installs;
  * the GPU render slot is exclusive: /render is rejected (409) while a
    worker is running. The worker does NOT hold the slot itself — each
    pipeline claims it via its own `active_job`, because the slot lock is
    non-reentrant (double-acquire in one thread raises RuntimeError);
  * cancellation goes through the pipelines' own JobController
    (cancel_active_job), which also removes incomplete output files;
  * the heavy prepare_runtime() step (DLL validation, GPU detection,
    mmap warm-up) runs in a background thread; /health reports ready/error.
"""

from __future__ import annotations

import dataclasses
import json
import math
import os
import sys
import threading
import time
import traceback
import uuid as _uuid
from dataclasses import asdict, is_dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PORT = int(os.environ.get("UPSCALE_BRIDGE_PORT", "7890"))
OUTPUT_DIR = Path(os.environ.get("UPSCALE_OUTPUT_DIR") or (ROOT / "outputs"))

# ─────────────────────────────────────────────────────────────
# Logging (stdout — piped to the host console by the runner)
# ─────────────────────────────────────────────────────────────
_LOG_LOCK = threading.Lock()
_LOG_LINES: list[str] = []


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    with _LOG_LOCK:
        _LOG_LINES.append(line)
        if len(_LOG_LINES) > 400:
            del _LOG_LINES[:200]
    # Windows console may use cp866: symbols like "→" cannot be encoded and
    # print() raises UnicodeEncodeError. Logging must not kill the render worker.
    try:
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        sys.stdout.write(line.encode(enc, "replace").decode(enc, "replace") + "\n")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass


def log_tail(n: int = 12) -> list[str]:
    with _LOG_LOCK:
        return list(_LOG_LINES[-n:])


# ─────────────────────────────────────────────────────────────
# Runtime preparation (background thread)
# ─────────────────────────────────────────────────────────────
READY = False
READY_ERROR: str | None = None
GPUS: list[dict[str, Any]] = []

# Frame Interpolation (DLSSG) capabilities — background probe after runtime is ready.
FI_CAPS: dict[str, Any] | None = None


def _probe_fi_capabilities() -> None:
    """Probe DLSSG (Frame Generation) support. Light: worker query + registry check."""
    global FI_CAPS
    try:
        from src.frame_interpolation.capabilities import probe_frame_interpolation_capabilities
        caps = probe_frame_interpolation_capabilities("auto")
        FI_CAPS = {
            "available": bool(caps.available),
            "gpu": str(caps.gpu or ""),
            "driver": str(caps.driver or ""),
            "hags_enabled": bool(caps.hags_enabled),
            "detail": str(caps.detail or ""),
        }
        state = "available" if caps.available else "UNavailable"
        log(f"Frame Interpolation (DLSSG): {state}; HAGS on: {caps.hags_enabled}; {caps.detail}")
    except Exception as exc:  # noqa: BLE001
        FI_CAPS = {"available": False, "detail": f"{type(exc).__name__}: {exc}"}
        log(f"Frame Interpolation (DLSSG): probe failed: {exc}")


def _prepare_runtime() -> None:
    """Validate DLSS runtime files, detect GPUs, warm mappings, init color mgmt."""
    global READY, READY_ERROR, GPUS
    t0 = time.time()
    log("Preparing DLSS runtime (DLL validation, GPU, file warm-up)…")
    try:
        from src.core.gpu_selection import gpu_choice_label
        from src.core.runtime import prepare_runtime
        from src.neural_rendering.image.decoder import initialize_image_runtime

        prepared = prepare_runtime()
        initialize_image_runtime()
        gpus: list[dict[str, Any]] = []
        for gpu in prepared.gpus:
            gpus.append(
                {
                    "uuid": str(gpu.get("uuid") or ""),
                    "label": gpu_choice_label(gpu),
                    "ai_compatible": bool(gpu.get("ai_compatible")),
                    "memory_gb": round(float(gpu.get("memory_mb") or 0) / 1024.0, 1),
                }
            )
        GPUS = gpus
        READY = True
        log(f"Runtime ready in {time.time() - t0:.1f} s; GPU: {len(gpus)}")
        threading.Thread(
            target=_probe_fi_capabilities, name="upscale-fi-probe", daemon=True,
        ).start()
    except BaseException as exc:  # noqa: BLE001 — report anything to the UI
        READY_ERROR = f"{type(exc).__name__}: {exc}"
        log(f"Runtime preparation FAILED: {READY_ERROR}")
        log(traceback.format_exc(limit=8))


def _start_prepare_thread() -> None:
    threading.Thread(target=_prepare_runtime, name="upscale-prepare", daemon=True).start()


# ─────────────────────────────────────────────────────────────
# Feature registry (options classes + run functions + schema)
# ─────────────────────────────────────────────────────────────
class FeatureDef:
    def __init__(self, key: str, label: str, media: str, options_cls: type, run: Callable) -> None:
        self.key = key
        self.label = label
        self.media = media
        self.options_cls = options_cls
        self.run = run


FEATURES: dict[str, FeatureDef] = {}


def _build_options(defn: FeatureDef, raw: dict[str, Any]):
    """Build the options dataclass from a JSON dict; drop unknown keys.

    Unknown keys (stale UI fields) are ignored instead of failing the
    whole render — the dataclass defaults still apply.
    """
    allowed = {f.name for f in dataclasses.fields(defn.options_cls)}
    clean = {k: v for k, v in (raw or {}).items() if k in allowed}
    # (fix 162) scale_factor comes from UI select as string "1.5";
    # validate() requires number — cast here, otherwise raises ValueError.
    if 'scale_factor' in clean and isinstance(clean['scale_factor'], str):
        try:
            clean['scale_factor'] = float(clean['scale_factor'])
        except (ValueError, TypeError):
            pass  # validate() will catch non-numeric value
    return defn.options_cls(**clean)


def _make_run(defn: FeatureDef, extra_kwargs: dict[str, Any]):
    def run(input_path: str, options_obj: Any, progress: Callable) -> Any:
        return defn.run(input_path, options_obj, progress, **extra_kwargs)

    return run


def _register_features() -> None:
    from src.core.ffmpeg.codecs import CODEC_CHOICES, ENCODING_QUALITIES
    from src.core.runtime import (
        DLSS_MODEL_PRESETS,
        NR_PRESETS,
        NR_STYLES,
        UPSCALING_CHOICES,
    )
    from src.frame_interpolation.models import ENGINE_CHOICES, FPS_CHOICES, FrameInterpolationOptions
    from src.neural_rendering.image.models import IMAGE_FORMATS, ImageConversionOptions
    from src.neural_rendering.video.models import ConversionOptions
    from src.upscale.image.models import ImageUpscaleOptions
    from src.upscale.video.models import (
        HDR_PRECISION_CHOICES,
        SCALE_FACTORS,
        SIZE_MODES,
        VSR_QUALITIES,
        UpscaleOptions,
    )

    def _run_nr_image(path, options, progress, **kw):
        from src.neural_rendering.image.processor import convert_image

        return convert_image(
            path, options, progress, output_dir=str(OUTPUT_DIR),
            generate_previews=False, create_zip=False, controller=kw.get("controller"),
        )

    def _run_nr_video(path, options, progress, **kw):
        from src.neural_rendering.video.processor import convert_video

        return convert_video(
            path, options, progress, output_dir=str(OUTPUT_DIR), controller=kw.get("controller"),
        )

    def _run_vsr_image(path, options, progress, **kw):
        from src.upscale.image.processor import upscale_image

        return upscale_image(
            path, options, progress, output_dir=str(OUTPUT_DIR), generate_previews=False,
            controller=kw.get("controller"),
        )

    def _run_vsr_video(path, options, progress, **kw):
        from src.upscale.video.processor import upscale_video

        return upscale_video(
            path, options, progress, output_dir=str(OUTPUT_DIR), controller=kw.get("controller"),
        )

    def _run_fi_video(path, options, progress, **kw):
        from src.frame_interpolation.processor import interpolate_video

        return interpolate_video(
            path, options, progress, output_dir=str(OUTPUT_DIR), controller=kw.get("controller"),
        )

    FEATURES["nr-image"] = FeatureDef("nr-image", "Neural Rendering — Image", "image",
                                      ImageConversionOptions, _run_nr_image)
    FEATURES["nr-video"] = FeatureDef("nr-video", "Neural Rendering — Video", "video",
                                      ConversionOptions, _run_nr_video)
    FEATURES["vsr-image"] = FeatureDef("vsr-image", "RTX Video Super Resolution — Image", "image",
                                       ImageUpscaleOptions, _run_vsr_image)
    FEATURES["vsr-video"] = FeatureDef("vsr-video", "RTX Video Super Resolution — Video", "video",
                                       UpscaleOptions, _run_vsr_video)
    FEATURES["fi-video"] = FeatureDef("fi-video", "Frame Interpolation (DLSSG)", "video",
                                      FrameInterpolationOptions, _run_fi_video)

    global SCHEMA
    SCHEMA = {
        "features": {
            key: {
                "label": defn.label,
                "media": defn.media,
                "quality_kind": "int" if key in ("nr-image", "vsr-image") else "str",
                "defaults": asdict(defn.options_cls()),
                "choices": {},
            }
            for key, defn in FEATURES.items()
        }
    }
    SCHEMA["features"]["nr-image"]["choices"] = {
        "nr_preset": list(NR_PRESETS),
        "nr_style": list(NR_STYLES),
        "dlss_model_preset": list(DLSS_MODEL_PRESETS),
        "upscaling_factor": [[label, factor] for label, factor in UPSCALING_CHOICES],
        "output_format": list(IMAGE_FORMATS),
        "rename_mode": ["Auto", "Custom"],
    }
    SCHEMA["features"]["nr-video"]["choices"] = {
        "nr_preset": list(NR_PRESETS),
        "nr_style": list(NR_STYLES),
        "dlss_model_preset": list(DLSS_MODEL_PRESETS),
        "upscaling_factor": [[label, factor] for label, factor in UPSCALING_CHOICES],
        "codec": list(CODEC_CHOICES),
        "quality": list(ENCODING_QUALITIES),
        "container": ["MP4", "MKV", "MOV"],
        "rename_mode": ["Auto", "Custom"],
    }
    SCHEMA["features"]["vsr-image"]["choices"] = {
        "vsr_quality": [[label, value] for label, value in VSR_QUALITIES],
        "size_mode": list(SIZE_MODES),
        # (fix 162) pairs [label, value] — like vsr_quality; UI itemsFrom
        # takes v[1] = number, and scale_factor goes to bridge as number.
        "scale_factor": [[label, value] for label, value in SCALE_FACTORS],
        "output_format": list(IMAGE_FORMATS),
        "rename_mode": ["Auto", "Custom"],
    }
    SCHEMA["features"]["vsr-video"]["choices"] = {
        "vsr_quality": [[label, value] for label, value in VSR_QUALITIES],
        "size_mode": list(SIZE_MODES),
        "scale_factor": [[label, value] for label, value in SCALE_FACTORS],
        "hdr_precision": [label for label, _ in HDR_PRECISION_CHOICES],
        "codec": list(CODEC_CHOICES),
        "quality": list(ENCODING_QUALITIES),
        "container": ["MP4", "MKV", "MOV"],
        "rename_mode": ["Auto", "Custom"],
    }
    SCHEMA["features"]["fi-video"]["choices"] = {
        "target_fps": list(FPS_CHOICES),
        "engine": list(ENGINE_CHOICES),
        "codec": list(CODEC_CHOICES),
        "quality": list(ENCODING_QUALITIES),
        "container": ["MP4", "MKV", "MOV"],
        "rename_mode": ["Auto", "Custom"],
    }


SCHEMA: dict[str, Any] = {"features": {}}


# ─────────────────────────────────────────────────────────────
# Jobs
# ─────────────────────────────────────────────────────────────
class Job:
    def __init__(self, feature: str, input_path: str, options_raw: dict[str, Any]) -> None:
        self.id = _uuid.uuid4().hex[:12]
        self.feature = feature
        self.input = str(input_path)
        self.options_raw = dict(options_raw or {})
        self.controller = None  # JobController; set by the worker before the pipeline starts
        self.status = "queued"
        self.progress = 0.0
        self.message = "Waiting for GPU"
        self.error: str | None = None
        self.output: dict[str, Any] | None = None
        self.created = time.time()

    def payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "feature": self.feature,
            "input": self.input,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "created": self.created,
            "output": self.output,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
RENDER_BUSY = False
RENDER_BUSY_LOCK = threading.Lock()


def _job_list_payload() -> list[dict[str, Any]]:
    with JOBS_LOCK:
        items = list(JOBS.values())
    items.sort(key=lambda j: j.created, reverse=True)
    return [j.payload() for j in items[:50]]


def _worker(job: Job) -> None:
    global RENDER_BUSY
    # (fix 716) Import — INSIDE guard block: previously it was above
    # try/finally, and an import failure (or any BaseException) left
    # RENDER_BUSY True forever — bridge stopped accepting jobs.
    try:
        from src.core.jobs import Cancelled, JobController
    except BaseException:
        log(f"job {job.id} [{job.feature}] failed to import src.core.jobs:")
        log(traceback.format_exc(limit=6))
        job.status = "error"
        job.error = "Failed to start processing"
        with RENDER_BUSY_LOCK:
            RENDER_BUSY = False
        return

    defn = FEATURES.get(job.feature)
    if defn is None:
        job.status = "error"
        job.error = f"Unknown feature: {job.feature}"
        # (fix 356) Reset RENDER_BUSY under lock, as in finally below —
        # without lock a race is possible with concurrent POST /render (check +
        # set in do_POST is also under RENDER_BUSY_LOCK).
        with RENDER_BUSY_LOCK:
            RENDER_BUSY = False
        return

    job.status = "running"
    job.message = "Starting…"

    def progress_cb(value: Any, message: str = "") -> None:
        try:
            v = float(value)
        except (TypeError, ValueError):
            v = job.progress
        if math.isfinite(v):
            job.progress = max(0.0, min(1.0, v))
        if message:
            job.message = str(message)

    try:
        controller = job.controller
        if controller is None:  # guard against Jobs created before fix
            controller = JobController()
            job.controller = controller
        # Cancellation could arrive during queued→running window (controller is now
        # created synchronously in _start_job) — do not start pipeline in vain.
        if controller.cancel.is_set():
            raise Cancelled()
        options_obj = _build_options(defn, job.options_raw)
        # The pipeline claims the GPU slot itself (active_job). Holding the
        # slot here would double-acquire the non-reentrant slot lock in the
        # same thread and raise "Another GPU render is already running."
        result = defn.run(job.input, options_obj, progress_cb, controller=controller)
        if is_dataclass(result):
            job.output = asdict(result)
        else:
            job.output = {"output_path": str(result)}
        # (fix 716) Order is important: progress and message are set
        # BEFORE status. Previously status was set first, and HTTP poll of /jobs
        # (another thread) could observe status="done" with progress=0.4 —
        # UI showed "ready" with incomplete progress.
        job.progress = 1.0
        job.message = "Done"
        job.status = "done"
        out = job.output.get("output_path") if isinstance(job.output, dict) else None
        log(f"job {job.id} [{job.feature}] done: {out}")
    except Cancelled:
        job.status = "cancelled"
        job.message = "Cancelled by user"
        log(f"job {job.id} [{job.feature}] cancelled")
    except Exception as exc:  # noqa: BLE001 — surface to the UI verbatim
        job.status = "error"
        job.error = f"{type(exc).__name__}: {exc}"
        if job.feature == "fi-video" and "Frame Generation is unavailable" in str(exc):
            job.error = (
                "DLSS Frame Generation (DLSSG) is unavailable on this system. Feature requires "
                "RTX 40-series GPU (or newer) and enabled Hardware-Accelerated GPU Scheduling "
                "(Windows Settings → Display → Graphics → 'Hardware-accelerated GPU scheduling' → On → restart). "
                "Neural Rendering and Upscale (VSR) work on this GPU. Details: " + str(exc)
            )
        log(f"job {job.id} [{job.feature}] error: {job.error}")
        log(traceback.format_exc(limit=6))
    finally:
        with RENDER_BUSY_LOCK:
            RENDER_BUSY = False


def _start_job(feature: str, input_path: str, options_raw: dict[str, Any]) -> Job:
    global RENDER_BUSY
    with RENDER_BUSY_LOCK:
        if RENDER_BUSY:
            raise BusyRender()
        RENDER_BUSY = True
    # (fix 716) Job creation and thread launch — UNDER try/except.
    # Previously RENDER_BUSY=True was set BEFORE these lines, and only reset in
    # _worker thread's finally. Any exception here (JobController import error,
    # "can't start new thread" under load) left the flag
    # True FOREVER: bridge gave 409 "GPU busy" forever even when GPU was free,
    # with no way to reset the flag.
    try:
        job = Job(feature, input_path, options_raw)
        # Controller — immediately upon job creation: cancellation in queued→running
        # window (thread hasn't reached pipeline yet) was previously silently lost.
        from src.core.jobs import JobController

        job.controller = JobController()
        with JOBS_LOCK:
            JOBS[job.id] = job
            if len(JOBS) > 200:
                oldest = sorted(JOBS.items(), key=lambda kv: kv[1].created)[:50]
                for key, _ in oldest:
                    JOBS.pop(key, None)
        threading.Thread(target=_worker, args=(job,), daemon=True, name=f"upscale-{job.id}").start()
        return job
    except BaseException:
        # Thread didn't start → its finally won't run → reset flag ourselves.
        with RENDER_BUSY_LOCK:
            RENDER_BUSY = False
        raise


class BusyRender(RuntimeError):
    pass


# ─────────────────────────────────────────────────────────────
# Probe (media metadata for the upload card)
# ─────────────────────────────────────────────────────────────
_VIDEO_EXTS = {
    ".mp4", ".m4v", ".mov", ".mkv", ".avi", ".webm", ".m2ts", ".mts", ".ts",
    ".mxf", ".vob", ".wmv", ".flv", ".mpg", ".mpeg", ".mpe", ".ogv", ".3gp",
    ".asf", ".divx", ".f4v",
}


def _probe(input_path: str) -> dict[str, Any]:
    path = Path(input_path)
    if not path.is_file():
        raise ValueError(f"File not found: {input_path}")
    size = path.stat().st_size
    out: dict[str, Any] = {"input": str(path), "size_bytes": size, "name": path.name}
    suffix = path.suffix.lower()
    if suffix in _VIDEO_EXTS:
        from src.core.ffmpeg.probe import probe_video

        meta = probe_video(path, count_mode="metadata")
        out["kind"] = "video"
        for key in ("width", "height", "fps", "duration", "frames", "codec", "hdr", "format"):
            if key in meta:
                value = meta[key]
                if isinstance(value, (int, float, bool, str)) or value is None:
                    out[key] = value
        return out
    from PIL import Image

    with Image.open(path) as img:
        out["kind"] = "image"
        out["width"], out["height"] = img.size
        out["format"] = img.format or ""
    return out


# ─────────────────────────────────────────────────────────────
# HTTP server
# ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MinimaxUpscaleBridge/1.0"

    # quiet default request logging — we keep our own tail
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: N802
        log(f"HTTP {fmt % args}")

    # ── helpers ──────────────────────────────────────────────
    def _send_json(self, code: int, obj: Any) -> None:
        payload = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        # (fix 716) Removed 'Access-Control-Allow-Origin: *'. The bridge listens on
        # 127.0.0.1 and is accessed ONLY by the studio server backend
        # (src/lib/upscale-runner.ts) — browser never visits this port.
        # With '*' any open website could read /probe and /jobs (absolute
        # local paths, filenames) and trigger renders on the user's machine
        # (simple request with Content-Type: text/plain bypasses preflight).
        # Bridge responses are now read only by its own origin.
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _origin_rejected(self) -> bool:
        """(fix 716) Reject request coming from a browser.

        Browsers always send Origin for cross-origin requests; studio backend
        (Node fetch) does not send Origin. Therefore presence of Origin
        indicates "this is a web page", not the studio → 403. Closes both CSRF
        and DNS-rebinding with reading local file metadata."""
        origin = self.headers.get("Origin")
        if not origin:
            return False
        try:
            from urllib.parse import urlsplit
            parts = urlsplit(origin)
        except Exception:
            return True
        host = (parts.hostname or "").lower()
        return host not in ("127.0.0.1", "localhost", "::1")

    def _read_json_body(self, limit: int = 1_000_000) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError("Request too large")
        raw = self.rfile.read(length)
        text = raw.decode("utf-8", "replace").strip() or "{}"
        data = json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("Expected a JSON object")
        return data

    def _path(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    # ── GET ──────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802
        path = self._path()
        try:
            if self._origin_rejected():
                self._send_json(403, {"error": "Cross-origin request forbidden"})
                return
            if path in ("/", "/health"):
                self._send_json(200, {
                    "ok": True,
                    "ready": READY,
                    "error": READY_ERROR,
                    "gpus": GPUS,
                    "port": PORT,
                    "output_dir": str(OUTPUT_DIR),
                    "features": sorted(FEATURES),
                    "fi": FI_CAPS,
                    "log_tail": log_tail(8),
                })
                return
            if path == "/schema":
                self._send_json(200, SCHEMA)
                return
            if path == "/jobs":
                self._send_json(200, {"jobs": _job_list_payload()})
                return
            if path.startswith("/jobs/"):
                job_id = path[len("/jobs/"):]
                with JOBS_LOCK:
                    job = JOBS.get(job_id)
                if job is None:
                    self._send_json(404, {"error": "Job not found"})
                    return
                self._send_json(200, job.payload())
                return
            self._send_json(404, {"error": f"Unknown path: {path}"})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})

    # ── POST ─────────────────────────────────────────────────
    def do_POST(self) -> None:  # noqa: N802
        path = self._path()
        try:
            if self._origin_rejected():
                self._send_json(403, {"error": "Cross-origin request forbidden"})
                return
            body = self._read_json_body()
            if path == "/render":
                feature = str(body.get("feature") or "")
                input_path = str(body.get("input") or "")
                if feature not in FEATURES:
                    self._send_json(400, {"error": f"Unknown feature: {feature!r}. "
                                                   f"Available: {', '.join(sorted(FEATURES))}"})
                    return
                if not input_path:
                    self._send_json(400, {"error": "No input file specified (input)"})
                    return
                try:
                    job = _start_job(feature, input_path, body.get("options") or {})
                except BusyRender:
                    self._send_json(409, {"error": "GPU is busy: another render is already running. Please wait for completion."})
                    return
                self._send_json(202, {"ok": True, "jobId": job.id})
                return
            if path.startswith("/jobs/") and path.endswith("/cancel"):
                job_id = path[len("/jobs/"):-len("/cancel")]
                from src.core.jobs import cancel_active_job, is_active_job

                with JOBS_LOCK:
                    job = JOBS.get(job_id)
                if job is None:
                    self._send_json(404, {"ok": False, "error": "Job not found"})
                    return
                # If pipeline hasn't acquired slot yet, stop its controller directly
                # (cancel_active_job only sees active slot).
                controller = getattr(job, "controller", None)
                if controller is not None:
                    try:
                        controller.stop()
                    except Exception:  # noqa: BLE001
                        pass
                # Cancel active render ONLY if this job is the active one:
                # previously unconditional cancel_active_job() stopped SOMEONE ELSE'S
                # task (cancelling old completed job killed current render).
                if controller is not None and is_active_job(controller):
                    message = cancel_active_job()
                else:
                    message = "Stop requested."
                self._send_json(200, {"ok": True, "message": message})
                return
            if path == "/probe":
                input_path = str(body.get("input") or "")
                if not input_path:
                    self._send_json(400, {"error": "No file specified (input)"})
                    return
                self._send_json(200, _probe(input_path))
                return
            self._send_json(404, {"error": f"Unknown path: {path}"})
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})


def main() -> None:
    log(f"Upscale bridge: port {PORT}, output in {OUTPUT_DIR}")
    try:
        _register_features()
        log(f"Features registered: {', '.join(sorted(FEATURES))}")
    except Exception as exc:  # noqa: BLE001
        log(f"FAILED to initialize features catalog: {type(exc).__name__}: {exc}")
        log(traceback.format_exc(limit=8))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    _start_prepare_thread()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("Bridge stopped")


if __name__ == "__main__":
    main()
