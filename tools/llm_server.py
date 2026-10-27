"""
llm_server.py — local LLM bridge for MiniMax H3 Studio (fix 24).

Runs INSIDE the ComfyUI embedded python (llama-cpp-python is already
installed there — CPU + CUDA backends). Standard library only besides
llama_cpp itself: no FastAPI/uvicorn dependency.

Endpoints (127.0.0.1 only):
  GET  /health    -> {"ok": true, "model": ..., "gpu_layers": N}
  POST /chat      -> SSE stream of {"delta": "..."} chunks, ends with {"done": true}
                     body: {"messages": [{"role","content"}], "max_tokens"?, "temperature"?,
                             "stop"?: [str], "stream"?: bool}
                     stream:false -> plain JSON {"ok": true, "text": "...", "finish_reason": ...}
                     (used for reliability audio probes — see src/lib/llm-audio-guard.ts)
  POST /abort     -> stop the current generation (best effort)
  POST /shutdown  -> graceful shutdown (releases VRAM, then exits)

Auto-exits after --idle-sec without requests (frees RAM/VRAM).
"""

import argparse
import hashlib
import inspect
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# (fix 477) Windows console (cp1251) lacks some Unicode characters (e.g. '≈') —
# printing such characters threw UnicodeEncodeError (fix 62 crashed on n_keep log).
# Reconfigure stdout/stderr to UTF-8 with replacement for invalid characters.
import sys as _sys
for _stream_name in ('stdout', 'stderr'):
    _s = getattr(_sys, _stream_name, None)
    try:
        if _s is not None and hasattr(_s, 'reconfigure'):
            _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# ── args ──
ap = argparse.ArgumentParser()
# (fix 716) --model is NOT required at argparse level: module is designed
# to be importable for tests (GGUF parser / VRAM calculation), but parse_args()
# with required=True exited with SystemExit(2) on import. Check moved to __main__.
ap.add_argument('--model', default='')
ap.add_argument('--mmproj', default=None, help='Path to multimodal projector (mmproj/MTP) for vision')
ap.add_argument('--port', type=int, default=8090)
ap.add_argument('--gpu-layers', type=int, default=0, help='0 = CPU only, -1 = auto (VRAM-capped)')
ap.add_argument('--max-vram-percent', type=int, default=90,
               help='Max %% of total VRAM to use (default 90, fix 60: back to the original 90%)')
ap.add_argument('--ctx', type=int, default=4096)
# (fix 109) KV cache quantization: off (fp16, default) | q8_0 | q5_1 | q4_0
ap.add_argument('--kv-cache', default='off', choices=['off', 'q8_0', 'q5_1', 'q4_0'],
               help='KV cache quantization (off=fp16, default)')
ap.add_argument('--threads', type=int, default=6)
ap.add_argument('--idle-sec', type=int, default=600)
# (fix 716) parse_known_args — extra arguments should not crash the server.
args, _unknown_args = ap.parse_known_args()

# (fix 109) KV cache quantization -> int enum type from pinned build
# llama-cpp-python 0.3.46 (_ggml.py): off -> None (fp16), q8_0 -> 8, q5_1 -> 7,
# q4_0 -> 2. Applied equally to K and V (type_k = type_v).
KV_TYPE_MAP = {'off': None, 'q8_0': 8, 'q5_1': 7, 'q4_0': 2}
kv_type = KV_TYPE_MAP[args.kv_cache]

# ── Ensure CUDA runtime DLLs are findable ──────────────────────────────
# llama-cpp-python's ggml-cuda.dll needs cublas/cudart/cufft/cublasLt at
# load time. PyTorch ships them in torch/lib/. We copy the required DLLs
# into llama_cpp/lib/ so the Windows loader finds them automatically
# (no PATH manipulation needed, fully portable).
import os, sys, shutil
if sys.platform == 'win32':
    try:
        import torch, llama_cpp
        _torch_lib = os.path.join(os.path.dirname(torch.__file__), 'lib')
        _llama_lib = os.path.join(os.path.dirname(llama_cpp.__file__), 'lib')
        _cuda_dlls = ['cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll', 'cufft64_12.dll']
        for _dll in _cuda_dlls:
            _src = os.path.join(_torch_lib, _dll)
            _dst = os.path.join(_llama_lib, _dll)
            if os.path.isfile(_src) and not os.path.isfile(_dst):
                shutil.copy2(_src, _dst)
                print(f'[llm] copied {_dll} to llama_cpp/lib/', flush=True)
    except ImportError:
        pass  # torch or llama_cpp not available — fall back to CPU
    except Exception as exc:  # noqa: BLE001
        # (fix 716) Copying CUDA-DLL — best effort. Previously only ImportError was caught;
        # PermissionError or FileExistsError crashed process with raw traceback before port binding.
        print(f'[llm] failed to prepare CUDA DLL ({type(exc).__name__}: {exc}) — '
              f'continuing without them', flush=True)

print(f'[llm] loading model: {args.model} (gpu_layers={args.gpu_layers}, ctx={args.ctx}, kv_cache={args.kv_cache}, mmproj={args.mmproj or "none"})', flush=True)

from llama_cpp import Llama  # noqa: E402

# GGUF value-type map (vtype -> size in bytes; 'S' = string, 'A' = array).
# (fix 716) Unified working table for v2 and v3: enum of GGUF types did not change
# between versions (UINT8=0, INT8=1, UINT16=2, INT16=3, UINT32=4, INT32=5,
# FLOAT32=6, BOOL=7, STRING=8, ARRAY=9, UINT64=10, INT64=11, FLOAT64=12).
_GGUF_SIZES = {0: 1,    # UINT8
               1: 1,    # INT8
               2: 2,    # UINT16
               3: 2,    # INT16
               4: 4,    # UINT32
               5: 4,    # INT32
               6: 4,    # FLOAT32
               7: 1,    # BOOL
               8: 'S',  # STRING
               9: 'A',  # ARRAY
               10: 8,   # UINT64
               11: 8,   # INT64
               12: 8}   # FLOAT64
_GGUF_V2_SIZES = _GGUF_SIZES
_GGUF_V3_SIZES = _GGUF_SIZES
_GGUF_MAX_STR = 200_000_000   # sanity cap: a single string can't be 200MB
_GGUF_MAX_ARR = 10_000_000    # sanity cap: array elements


def _read_gguf_meta(model_path):
    """Read architecture metadata from a GGUF file header (v2 and v3).

    Returns dict: block_count, embedding_length, head_count, head_count_kv.
    head_count_kv is a scalar (max element when the file stores it as a
    per-layer array — Gemma-4 style hybrid attention). Missing -> None.

    Arrays (both versions): uint32 element-type + uint64 count + inline
    elements; strings: uint64 length + bytes. Recursion-safe.
    """
    import struct

    result = {
        'block_count': None,
        'embedding_length': None,
        'head_count': None,
        'head_count_kv': None,
    }

    def _skip_value(f, vtype, sizes, depth):
        if depth > 4:
            raise ValueError('array nesting too deep')
        spec = sizes.get(vtype)
        if spec is None:
            raise ValueError(f'unknown vtype {vtype}')
        if spec == 'S':
            str_len = struct.unpack('<Q', f.read(8))[0]
            if str_len > _GGUF_MAX_STR:
                raise ValueError('string too long')
            if len(f.read(str_len)) != str_len:
                raise ValueError('truncated string')
            return None
        if spec == 'A':
            etype = struct.unpack('<I', f.read(4))[0]
            count = struct.unpack('<Q', f.read(8))[0]
            if count > _GGUF_MAX_ARR:
                raise ValueError('array too long')
            vals = []
            for _ in range(count):
                vals.append(_skip_value(f, etype, sizes, depth + 1))
            return vals
        # (fix 716) Check that exactly spec bytes were read: mismatch means
        # metadata stream desync — safer to return empty result than compute VRAM on garbage.
        if len(f.read(spec)) != spec:
            raise ValueError('truncated value')
        return None

    def _read_int(f, vtype, sizes):
        """Read a scalar integer value (any int vtype). Returns int or None."""
        spec = sizes.get(vtype)
        if spec in (1, 2, 4, 8):
            raw = f.read(spec)
            return int.from_bytes(raw, 'little', signed=False)
        return None

    try:
        with open(model_path, 'rb') as f:
            if f.read(4) != b'GGUF':
                return result
            version = struct.unpack('<I', f.read(4))[0]
            f.read(8)  # tensor count (not needed)
            kv_count = struct.unpack('<Q', f.read(8))[0]
            if kv_count > 100_000:
                return result
            sizes = _GGUF_V3_SIZES if version >= 3 else _GGUF_V2_SIZES

            for _ in range(kv_count):
                key_len = struct.unpack('<Q', f.read(8))[0]
                if key_len > 1024:
                    break
                key = f.read(key_len).decode('utf-8', errors='replace')
                vtype = struct.unpack('<I', f.read(4))[0]

                target = None
                if result['block_count'] is None and key.endswith('.block_count'):
                    target = 'block_count'
                elif result['embedding_length'] is None and key.endswith('.embedding_length'):
                    target = 'embedding_length'
                elif result['head_count'] is None and key.endswith('.attention.head_count'):
                    target = 'head_count'
                elif result['head_count_kv'] is None and key.endswith('.attention.head_count_kv'):
                    target = 'head_count_kv'

                if target is not None:
                    spec = sizes.get(vtype)
                    if spec in (1, 2, 4, 8):
                        result[target] = _read_int(f, vtype, sizes)
                    elif spec == 'A':
                        # per-layer array (v3 hybrid models) — take the max
                        # element (conservative for VRAM estimates)
                        etype = struct.unpack('<I', f.read(4))[0]
                        count = struct.unpack('<Q', f.read(8))[0]
                        if count > _GGUF_MAX_ARR:
                            break
                        vals = []
                        for _e in range(count):
                            esp = sizes.get(etype)
                            if esp in (1, 2, 4, 8):
                                vals.append(_read_int(f, etype, sizes))
                            else:
                                _skip_value(f, etype, sizes, 1)
                        vals = [v for v in vals if v is not None]
                        if vals:
                            result[target] = max(vals)
                    else:
                        _skip_value(f, vtype, sizes, 0)
                    continue

                _skip_value(f, vtype, sizes, 0)
    except Exception:
        pass

    return result


def _calc_max_gpu_layers():
    """Calculate max GPU layers that fit in --max-vram-percent of total VRAM
    (fix 49 introduced the cap; fix 60: default 90% — the user-visible
    hard cap; rest of the layers stay on CPU).

    Also fixed here (fix 49): the GGUF header parser was written for v2
    and silently misread v3 files (gemma-4-12b Q4_K_M) — all metadata came
    back None, so the cap fell back to a loose 40-layer heuristic with zero
    KV estimate and over-filled VRAM (>94%) -> lag. Now v2+v3 are both
    parsed correctly (v3 renumbered vtypes: 8=STRING, 9=ARRAY, ...).

    Accounts for:
      - Weight memory: n_layers_gpu × per_layer_weight
      - KV cache memory: n_layers_gpu × per_layer_kv (scales with GPU layer count!)
      - CUDA context + cuBLAS workspaces + llama.cpp buffers (~768MB)

    Estimates are intentionally slightly conservative (KV safety margin),
    because under-reserving VRAM causes heavy lag (the original complaint).

    Returns the number of layers, -1 if everything fits (all on GPU),
    or None if calculation is impossible.
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return 0
        total_vram = torch.cuda.get_device_properties(0).total_memory
    except Exception:
        return None

    budget = int(total_vram * args.max_vram_percent / 100)

    try:
        model_size = os.path.getsize(args.model)
    except Exception:
        return None

    # Read GGUF metadata for accurate per-layer KV cache estimation
    meta = _read_gguf_meta(args.model)
    n_layers = meta['block_count']
    if n_layers is None or n_layers <= 0:
        n_layers = 40  # heuristic fallback

    # Per-layer weight size
    per_layer_weight = model_size / n_layers

    # Per-layer KV cache size:
    #   KV per layer = 2 (K+V) × n_ctx × n_kv_heads × head_dim × 2 (fp16)
    #   head_dim = n_embd / n_heads
    n_embd = meta['embedding_length']
    n_heads = meta['head_count']
    n_kv_heads = meta['head_count_kv']

    per_layer_kv = 0
    if n_embd and n_heads and n_heads > 0:
        if n_kv_heads is None:
            n_kv_heads = n_heads  # MHA (no GQA)
        head_dim = n_embd // n_heads
        # 2 (K+V) × n_ctx × kv_heads × head_dim × 2 bytes (fp16)
        per_layer_kv = 2 * args.ctx * n_kv_heads * head_dim * 2

    # Safety margin: Gemma-3/4 use an extended head_dim (e.g. 256) that is
    # larger than n_embd/n_heads (240), plus KV-cache alignment/padding in
    # llama.cpp. 1.25 keeps the estimate on the safe side (under-reserving
    # VRAM = lag, the bug we are fixing).
    KV_SAFETY = 1.25
    per_layer_kv = int(per_layer_kv * KV_SAFETY)

    # (fix 109) KV cache quantization reduces cache size per layer:
    # q8_0 ~0.55, q5_1 ~0.45, q4_0 ~0.30 of fp16. Conservative coefficients
    # -> fewer layers on GPU -> safer for VRAM.
    KV_QUANT_FACTOR = {'off': 1.0, 'q8_0': 0.55, 'q5_1': 0.45, 'q4_0': 0.30}
    per_layer_kv = int(per_layer_kv * KV_QUANT_FACTOR.get(args.kv_cache, 1.0))

    # CUDA context + cuBLAS workspaces + llama.cpp internal buffers
    OVERHEAD = 768 * 1024 * 1024  # ~768MB

    # Per-layer total = weight + kv_cache (both scale with GPU layer count)
    per_layer_total = per_layer_weight + per_layer_kv

    available = budget - OVERHEAD
    if available <= 0:
        return 0

    max_layers = max(0, int(available / per_layer_total))

    # If all layers fit, signal "all on GPU"
    if max_layers >= n_layers:
        max_layers = -1

    # Log detailed breakdown
    kv_detail = (f'kv/layer={per_layer_kv // (1024**2)}MB '
                 f'(kv_heads={n_kv_heads}, embd={n_embd}, heads={n_heads}) ')
    print(
        f'[llm] VRAM cap: total={total_vram / (1024**3):.1f}GB '
        f'budget({args.max_vram_percent}%)={budget / (1024**3):.1f}GB '
        f'overhead={OVERHEAD // (1024**2)}MB '
        f'model={model_size // (1024**2)}MB/{n_layers}L '
        f'w/layer={per_layer_weight // (1024**2)}MB '
        f'{kv_detail}'
        f'-> max_gpu_layers={max_layers}',
        flush=True,
    )
    return max_layers


def _build_llm(n_gpu_layers):
    kwargs = dict(
        model_path=args.model,
        n_gpu_layers=n_gpu_layers,
        n_ctx=args.ctx,
        n_threads=args.threads,
        verbose=False,
    )
    # (fix 109) KV cache quantization: type_k = type_v = selected type
    if kv_type is not None:
        kwargs['type_k'] = kv_type
        kwargs['type_v'] = kv_type
    if args.mmproj:
        kwargs['mmproj_path'] = args.mmproj
    return Llama(**kwargs)


def _load_with_fallback():
    """Load the model with VRAM-aware GPU layer selection.

    When --gpu-layers is -1 (auto), we calculate the maximum number of GPU
    layers that fit within --max-vram-percent of total VRAM (default 90%,
    fix 60). This prevents the system from using >90% VRAM and lagging;
    the rest of the layers automatically stay on CPU.
    Falls back to fewer layers on load failure.
    """
    requested = args.gpu_layers
    if requested < 0:
        # VRAM-capped auto: calculate max layers that fit in 90% VRAM (fix 60)
        calculated = _calc_max_gpu_layers()
        if calculated is None:
            candidates = [-1, 32, 16, 8, 0]
        elif calculated == -1:
            candidates = [-1, 0]  # all fits
        else:
            candidates = [calculated, calculated // 2, 0]
    elif requested > 0:
        candidates = [requested, 0]
    else:
        candidates = [0]
    last_err = None
    for cand in candidates:
        try:
            model = _build_llm(cand)
            print(
                f'[llm] model loaded (requested gpu_layers={requested}, used={cand})',
                flush=True,
            )
            # (fix 716) Remember EFFECTIVE GPU layer count so /health doesn't return -1.
            global EFFECTIVE_GPU_LAYERS
            EFFECTIVE_GPU_LAYERS = cand
            return model
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(
                f'[llm] gpu_layers={cand} load failed ({e}); retrying with fewer...',
                flush=True,
            )
    raise last_err


# ── state ──
last_activity = time.time()
gen_lock = threading.Lock()
abort_flag = threading.Event()
# (fix 717) Request id associated with abort.
abort_request_id = None  # type: str | None
abort_lock = threading.Lock()
shutdown_requested = threading.Event()
# (fix 716) Effective GPU layers loaded (None = model not yet loaded).
EFFECTIVE_GPU_LAYERS = None


def touch():
    global last_activity
    last_activity = time.time()


def _graceful_exit():
    """Release model resources and shut down the server cleanly."""
    global llm
    print('[llm] graceful shutdown - releasing model...', flush=True)
    shutdown_requested.set()
    if gen_lock.acquire(timeout=2.0):
        try:
            del llm
        except Exception:
            pass
        gen_lock.release()
    import gc
    gc.collect()
    print('[llm] model released, shutting down server', flush=True)
    threading.Thread(target=lambda: (server.shutdown(), server.server_close()), daemon=True).start()
    import os
    time.sleep(0.5)
    os._exit(0)


# ── (fix 62) System instructions pinned against context overflow ──
_n_keep_cache = {}  # sha1(system content) -> n_keep
_n_keep_lock = threading.Lock()


def _apply_system_n_keep(messages):
    """(fix 62) Pin system instructions: on context overflow llama.cpp drops
    tokens, but keeps the first n_keep tokens (system prompt). Increase n_keep
    to block size + safety margin for template tokens."""
    try:
        if not messages:
            return
        first = messages[0]
        if not isinstance(first, dict) or first.get('role') != 'system':
            return
        content = first.get('content') or ''
        if not isinstance(content, str) or not content:
            return
        # (fix 716) Stable key instead of hash()
        key = hashlib.sha1(content.encode('utf-8')).hexdigest()
        with _n_keep_lock:
            n_keep = _n_keep_cache.get(key)
            if n_keep is None:
                n_tokens = len(llm.tokenize(content.encode('utf-8'), add_bos=True, special=True))
                n_keep = n_tokens + 64  # margin for template wrapping and BOS
                _n_keep_cache[key] = n_keep
                if len(_n_keep_cache) > 8:
                    _n_keep_cache.clear()
                    _n_keep_cache[key] = n_keep
        current = getattr(llm, 'n_keep', 256)
        if n_keep > current:
            llm.n_keep = n_keep
            print(
                f'[llm] (fix 62) n_keep={n_keep} '
                f'(system ≈ {n_tokens} tokens) — instructions will be preserved '
                f'on context overflow',
                flush=True,
            )
    except Exception as e:  # noqa: BLE001
        print(f'[llm] (fix 62) n_keep not set: {e}', flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    # (fix 716) Socket timeout: prevents indefinite lock on dropped client connection.
    timeout = 60
    server_version = 'MinimaxLLM/1.0'
    def log_message(self, fmt, *a):  # silence default logging
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        touch()
        if self.path == '/health':
            self._json(200, {
                'ok': True,
                'model': args.model,
                'gpu_layers': EFFECTIVE_GPU_LAYERS if EFFECTIVE_GPU_LAYERS is not None else args.gpu_layers,
                'requested_gpu_layers': args.gpu_layers,
            })
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        global abort_request_id
        # (fix 353) int(Content-Length) with try/except
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except (TypeError, ValueError):
            return self._json(400, {'error': 'bad content-length'})
        if length < 0 or length > 64 * 1024 * 1024:
            return self._json(413, {'error': 'request too large'})

        # /shutdown — graceful exit (no body needed)
        if self.path == '/shutdown':
            self._json(200, {'ok': True, 'msg': 'shutting down'})
            threading.Timer(0.2, _graceful_exit).start()
            return

        touch()
        # (fix 716) /abort handled before body parsing
        if self.path == '/abort':
            raw_abort = b''
            if length > 0:
                try:
                    raw_abort = self.rfile.read(length)
                except Exception:
                    pass
            # (fix 717) request_id ensures abort targets the intended generation
            rid = None
            try:
                parsed_abort = json.loads(raw_abort or b'{}')
                if isinstance(parsed_abort, dict):
                    cand = parsed_abort.get('request_id')
                    if isinstance(cand, str) and cand:
                        rid = cand
            except Exception:
                rid = None
            if rid is None:
                from urllib.parse import parse_qs, urlsplit
                try:
                    q = parse_qs(urlsplit(self.path).query)
                    cand = (q.get('request_id') or [None])[0]
                    if isinstance(cand, str) and cand:
                        rid = cand
                except Exception:
                    rid = None
            with abort_lock:
                abort_flag.set()
                abort_request_id = rid
            return self._json(200, {'ok': True, 'request_id': rid})

        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            return self._json(400, {'error': 'bad json'})

        if self.path != '/chat':
            return self._json(404, {'error': 'not found'})

        # (fix 716) Body validation
        if not isinstance(body, dict):
            return self._json(400, {'error': 'body must be a JSON object'})
        messages = body.get('messages')
        if not isinstance(messages, list) or not messages:
            return self._json(400, {'error': 'messages required (non-empty array)'})
        for _m in messages:
            if not isinstance(_m, dict) or 'role' not in _m:
                return self._json(400, {'error': 'each message must be an object with a role'})

        # (fix 717) request_id
        request_id = None
        _rid = body.get('request_id')
        if isinstance(_rid, str) and _rid:
            request_id = _rid

        try:
            max_tokens = int(body.get('max_tokens') or 4096)
            temperature = float(body.get('temperature') or 0.7)
        except (TypeError, ValueError):
            return self._json(400, {'error': 'max_tokens/temperature must be numbers'})

        # (fix 135) fine-grained sampling settings
        def _f(key, default):
            v = body.get(key)
            if v is None:
                return default
            try:
                return float(v)
            except (TypeError, ValueError):
                raise ValueError(f'{key} must be a number')

        def _i(key, default):
            v = body.get(key)
            if v is None:
                return default
            try:
                return int(v)
            except (TypeError, ValueError):
                raise ValueError(f'{key} must be an integer')

        # (fix 716) present_penalty vs presence_penalty
        try:
            _presence = body.get('present_penalty', body.get('presence_penalty'))
            sampling = {
                'temperature': temperature,
                'top_p': _f('top_p', 0.95),
                'top_k': _i('top_k', 40),
                'min_p': _f('min_p', 0.05),
                'present_penalty': float(_presence) if _presence is not None else 0.0,
                'frequency_penalty': _f('frequency_penalty', 0.0),
                'repeat_penalty': _f('repeat_penalty', 1.0),
            }
        except (TypeError, ValueError) as exc:
            return self._json(400, {'error': f'invalid sampling parameters: {exc}'})

        # (fix 716) Clamp parameters
        sampling['temperature'] = max(0.0, min(2.0, sampling['temperature']))
        sampling['top_p'] = max(0.0, min(1.0, sampling['top_p']))
        sampling['min_p'] = max(0.0, min(1.0, sampling['min_p']))
        sampling['top_k'] = max(0, sampling['top_k'])
        sampling['present_penalty'] = max(-2.0, min(2.0, sampling['present_penalty']))
        sampling['frequency_penalty'] = max(-2.0, min(2.0, sampling['frequency_penalty']))
        sampling['repeat_penalty'] = max(0.0, min(2.0, sampling['repeat_penalty']))
        max_tokens = max(1, min(max_tokens, 32768))

        # (fix 503) Filter sampling parameters by method signature
        try:
            _sig_params = inspect.signature(llm.create_chat_completion).parameters
            if 'kwargs' not in _sig_params:
                _supported = set(_sig_params.keys())
                sampling = {k: v for k, v in sampling.items() if k in _supported}
        except (ValueError, TypeError):
            pass

        stop = body.get('stop')
        if stop is not None and not isinstance(stop, list):
            stop = [stop]
        stream = bool(body.get('stream', True))

        # ── Non-streaming mode: plain JSON (audio-probe path) ──
        if not stream:
            # (fix 341) Acquire with 5s timeout and 409 on contention
            if not gen_lock.acquire(timeout=5.0):
                return self._json(409, {
                    'ok': False,
                    'error': 'LLM is already generating another response — please wait',
                })
            try:
                # (fix 62) Apply system n_keep under gen_lock
                _apply_system_n_keep(messages)
                with abort_lock:
                    pre_aborted = abort_flag.is_set() and (
                        abort_request_id is None or abort_request_id == request_id
                    )
                    abort_flag.clear()
                    abort_request_id = None
                if pre_aborted:
                    return self._json(200, {
                        'ok': True,
                        'text': '',
                        'finish_reason': 'aborted',
                    })
                # (fix 354) Generation in separate thread with periodic touch()
                result = {}

                def _gen():
                    try:
                        result['res'] = llm.create_chat_completion(
                            messages=messages,
                            max_tokens=max_tokens,
                            stop=stop,
                            stream=False,
                            **sampling,
                        )
                    except Exception as e:  # noqa: BLE001
                        result['err'] = e

                t = threading.Thread(target=_gen, daemon=True)
                t.start()
                while t.is_alive():
                    t.join(timeout=5.0)
                    touch()
                if 'err' in result:
                    return self._json(500, {'ok': False, 'error': str(result['err'])})
                if abort_flag.is_set() or shutdown_requested.is_set():
                    return self._json(200, {
                        'ok': True,
                        'text': '',
                        'finish_reason': 'aborted',
                    })
                res = result.get('res') or {}
                choice = (res.get('choices') or [{}])[0]
                text = ((choice.get('message') or {}).get('content')) or ''
                return self._json(200, {
                    'ok': True,
                    'text': text,
                    'finish_reason': choice.get('finish_reason'),
                })
            finally:
                gen_lock.release()

        # LOCK BEFORE headers: busy server returns 409 JSON immediately
        if not gen_lock.acquire(timeout=5.0):
            return self._json(409, {
                'ok': False,
                'error': 'LLM is already generating another response — please wait',
            })

        def emit(obj):
            try:
                touch()
                self.wfile.write(f'data: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode('utf-8'))
                self.wfile.flush()
                return True
            except (BrokenPipeError, ConnectionResetError, OSError, socket.timeout):
                return False

        try:
            # (fix 716) _apply_system_n_keep under gen_lock
            _apply_system_n_keep(messages)
            # SSE response headers
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'close')
            self.end_headers()

            # (fix 716 / 717) Targeted abort snapshot
            with abort_lock:
                pre_aborted = abort_flag.is_set() and (
                    abort_request_id is None or abort_request_id == request_id
                )
                abort_flag.clear()
                abort_request_id = None
            if pre_aborted:
                emit({'done': True, 'finish_reason': 'aborted', 'aborted': True})
                return
            touch()
            finish_reason = None
            aborted = False
            try:
                stream = llm.create_chat_completion(
                    messages=messages,
                    max_tokens=max_tokens,
                    stop=stop,
                    stream=True,
                    **sampling,
                )
                for chunk in stream:
                    if abort_flag.is_set() or shutdown_requested.is_set():
                        aborted = True
                        break
                    choices = chunk.get('choices') or [{}]
                    delta = (choices[0].get('delta') or {})
                    text = delta.get('content')
                    if text:
                        if not emit({'delta': text}):
                            break
                    if choices[0].get('finish_reason'):
                        finish_reason = choices[0].get('finish_reason')
                # (fix 716) Final frame with finish_reason and aborted status
                emit({'done': True, 'finish_reason': finish_reason, 'aborted': aborted})
            except Exception as e:  # noqa: BLE001
                try:
                    emit({'error': str(e), 'done': True})
                except Exception:
                    pass
        finally:
            gen_lock.release()


def idle_watchdog():
    while True:
        time.sleep(10)
        if time.time() - last_activity > args.idle_sec:
            print('[llm] idle timeout - exiting', flush=True)
            _graceful_exit()


if __name__ == '__main__':
    # (fix 716) --model required when launched directly
    if not args.model:
        ap.error('the following arguments are required: --model')
    llm = _load_with_fallback()

    # Report GPU status
    try:
        import ctypes
        from llama_cpp._ggml import libggml
        libggml.ggml_backend_reg_count.argtypes = []
        libggml.ggml_backend_reg_count.restype = ctypes.c_size_t
        n_backends = libggml.ggml_backend_reg_count()
        device_str = 'GPU (CUDA)' if n_backends >= 2 else 'CPU'
        print(f'[llm] model loaded on {device_str} (backends: {n_backends})', flush=True)
    except Exception as e:
        print(f'[llm] model loaded (GPU check: {e})', flush=True)

    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as e:
        # (fix 342) Port already occupied
        print(
            f'[llm] FATAL: port {args.port} is already in use ({e}). '
            f'Close previous llm_server.py or restart studio.',
            flush=True,
        )
        raise SystemExit(2)
    threading.Thread(target=idle_watchdog, daemon=True).start()
    print(f'[llm] listening on 127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
