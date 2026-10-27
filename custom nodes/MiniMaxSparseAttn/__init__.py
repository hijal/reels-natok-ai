"""MiniMax Sparse Attention (Sol-Attn) — local custom node for ComfyUI 0.33.0.

(fix 168)
Ports the Sol-Attn path from official BlockSparseAttention (ComfyUI v0.35.0)
to ComfyUI 0.33.0, using only APIs available in this build:
  - transformer_options["optimized_attention_override"] (comfy/ldm/modules/attention.py)
  - comfy.patcher_extension.CallbacksMP.ON_PREPARE_STATE / ON_CLEANUP
  - model.model_options["transformer_options"]
  - model.get_model_object("model_sampling").percent_to_sigma
  - comfy_kitchen.sol_attn / sol_attn_is_available

VSA and SLA modes are NOT supported (require to_gate_compress / minimax_h3_layout,
not present in 0.33.0 H3 model). Sol-Attn is training-free and works on any model.

Defaults: tau=1.3, min_tokens=12288 (short sequences remain dense).
On failure (kernel unavailable, incompatible dtype, etc.) — automatic fallback to dense.

Installation: place this folder in custom_nodes/ — ComfyUI loads it at startup.
Removal: delete the MiniMaxSparseAttn folder from custom_nodes/.
"""
from __future__ import annotations

import logging
import torch

import comfy.patcher_extension
import comfy_kitchen as ck

HEAD_DIM = 128
BLOCK_SIZE = 64
PRODUCER_CHUNK = 4096


class SparseAttnPatch:
    """Parameters and runtime state for a single patched model.
    ON_CLEANUP callback resets state upon sampling completion."""

    def __init__(self, tau, sigma_start, sigma_end, min_tokens,
                 dense_blocks, extra_tokens, verbose):
        self.tau = tau
        self.sigma_start = sigma_start
        self.sigma_end = sigma_end
        self.min_tokens = min_tokens
        self.dense_blocks = dense_blocks
        self.extra_tokens = extra_tokens
        self.verbose = verbose
        self.installed = set()  # override-closures installed by this patch
        self.reset()

    def reset(self):
        self.pooled = {}
        self._logged = set()

    def log_once(self, key, message):
        if self.verbose and key not in self._logged:
            self._logged.add(key)
            logging.info(f"MiniMaxSparseAttn: {message}")

    def dense_reason(self, transformer_options, tokens, block_index):
        """Reason why this invocation remains dense (None = sparse eligible)."""
        sigmas = transformer_options.get("sigmas")
        if sigmas is not None:
            sigma = float(sigmas[0])
            if sigma > self.sigma_start or sigma < self.sigma_end:
                return f"sigma {sigma:.3g} outside start/end window"
        if tokens < self.min_tokens:
            return f"{tokens} tokens < min_tokens {self.min_tokens}"
        if self.dense_blocks:
            if block_index is None:
                self.log_once("no_block_index", "model does not provide block_index; dense_blocks ignored")
            elif block_index in self.dense_blocks:
                return f"block {block_index} in dense_blocks"
        return None


def _ineligible(q, k, v, dim_head):
    """Reason why tensors cannot pass through kernel, or None."""
    if q.device.type != "cuda":
        return "not on CUDA"
    try:
        if not ck.sol_attn_is_available(q.device):
            return "sol_attn kernel unavailable for this GPU"
    except Exception as e:
        return f"kernel availability check error: {e}"
    if q.dtype not in (torch.bfloat16, torch.float16, torch.float32):
        return f"dtype {q.dtype} (kernel expects bf16/fp16/fp32)"
    if dim_head != HEAD_DIM:
        return f"head_dim {dim_head} != {HEAD_DIM}"
    if q.shape != k.shape or q.shape != v.shape:
        return "cross-attention or GQA (remains dense)"
    if k.dtype != q.dtype or v.dtype != q.dtype:
        return f"differing dtypes: {q.dtype}/{k.dtype}/{v.dtype}"
    return None


def make_attention_override(patch: SparseAttnPatch, previous):
    """Returns override function substituting sparse attention.
    Rejected invocations fall back through previous (prior override) or func (dense)."""

    def override(func, q, k, v, heads, mask=None, attn_precision=None,
                 skip_reshape=False, skip_output_reshape=False, **kwargs):
        transformer_options = kwargs.get("transformer_options") or {}

        def dense():
            if previous is not None:
                return previous(func, q, k, v, heads, mask=mask,
                                attn_precision=attn_precision,
                                skip_reshape=skip_reshape,
                                skip_output_reshape=skip_output_reshape, **kwargs)
            return func(q, k, v, heads, mask=mask, attn_precision=attn_precision,
                        skip_reshape=skip_reshape, skip_output_reshape=skip_output_reshape, **kwargs)

        # Determine token count
        if skip_reshape:
            tokens = q.shape[2]
        else:
            tokens = q.shape[1]

        # Check sparse eligibility
        reason = patch.dense_reason(transformer_options, tokens, transformer_options.get("block_index"))
        if reason is not None:
            patch.log_once(("dense", tokens, reason), f"dense ({tokens} tokens): {reason}")
            return dense()

        # Build BTHD tensors
        if skip_reshape:
            b, _, _, dim_head = q.shape
            qs, ks, vs = (t.transpose(1, 2) for t in (q, k, v))
        else:
            b, _, dim_head = q.shape
            dim_head //= heads
            qs, ks, vs = (t.view(b, -1, heads, dim_head) for t in (q, k, v))

        reason = _ineligible(qs, ks, vs, dim_head)
        if reason is not None:
            patch.log_once(("ineligible", tuple(qs.shape), reason), f"dense {tuple(qs.shape)}: {reason}")
            return dense()

        # fp32 -> bf16 (kernel quantizes to int8 anyway)
        if q.dtype == torch.float32:
            qs, ks, vs = (t.to(torch.bfloat16) for t in (qs, ks, vs))

        # Invoke Sol-Attn kernel
        try:
            out = ck.sol_attn(
                qs, ks, vs,
                tau=patch.tau,
                scale=kwargs.get("scale"),
                sink_blocks=[],
                sink_q=[],
                topk_ratio=0.0,
                token_aug=patch.extra_tokens,
            ).to(q.dtype)
        except Exception as e:
            patch.log_once(("sparse_error", tuple(qs.shape)), f"sparse failed: {e}; fallback to dense")
            return dense()

        patch.log_once(("sparse", tuple(qs.shape)), f"sparse {tuple(qs.shape)}")

        # Format output in expected structure
        if skip_output_reshape:
            return out.transpose(1, 2)
        return out.reshape(b, -1, heads * dim_head)

    return override


def install_override(patch: SparseAttnPatch, transformer_options):
    """Installs override onto hook. Idempotent: does not reinstall if already present."""
    current = transformer_options.get("optimized_attention_override")
    if current in patch.installed:
        return
    override = make_attention_override(patch, current)
    patch.installed.add(override)
    transformer_options["optimized_attention_override"] = override


def apply_sparse_attention(model, *, tau, start_percent, end_percent,
                           min_tokens, dense_blocks, extra_tokens, verbose):
    """Core function: creates patched model copy with sparse attention override."""
    model_sampling = model.get_model_object("model_sampling")
    patch = SparseAttnPatch(
        tau=tau,
        sigma_start=float(model_sampling.percent_to_sigma(start_percent)),
        sigma_end=float(model_sampling.percent_to_sigma(end_percent)),
        min_tokens=min_tokens,
        dense_blocks=dense_blocks,
        extra_tokens=extra_tokens,
        verbose=verbose,
    )
    m = model.clone()
    to = m.model_options["transformer_options"]
    install_override(patch, to)
    m.add_callback_with_key(
        comfy.patcher_extension.CallbacksMP.ON_PREPARE_STATE,
        "minimax_sparse_attn",
        lambda model_patcher, timestep, model_options: install_override(patch, model_options["transformer_options"]),
    )
    m.add_callback_with_key(
        comfy.patcher_extension.CallbacksMP.ON_CLEANUP,
        "minimax_sparse_attn",
        lambda model_patcher: patch.reset(),
    )
    return m


class MiniMaxSparseAttention:
    """Custom ComfyUI node: Sol-Attn sparse attention (training-free).
    Accelerates long sequences (~1.2-2.5x), short sequences remain dense.
    On kernel error — automatic fallback to dense (workflow does not fail)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
            },
            "optional": {
                "tau": ("FLOAT", {"default": 1.3, "min": 0.0, "max": 4.0, "step": 0.05}),
                "start_percent": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 1.0, "step": 0.01}),
                "end_percent": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "min_tokens": ("INT", {"default": 12288, "min": 0, "max": 1 << 20, "step": 512}),
                "extra_tokens": ("INT", {"default": 256, "min": 0, "max": 256, "step": 64}),
                "verbose": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = "model/patch"
    DESCRIPTION = (
        "Sparse attention (Sol-Attn) — accelerates long sequences. "
        "Short sequences remain dense automatically (min_tokens)."
    )

    @classmethod
    def apply(cls, model, tau=1.3, start_percent=0.2, end_percent=1.0,
              min_tokens=12288, extra_tokens=256, verbose=False):
        # Kernel availability check: if unavailable — silently skip,
        # return unmodified model (dense fallback).
        try:
            import torch as _t
            device = _t.cuda.current_device()
            if not ck.sol_attn_is_available(device):
                if verbose:
                    logging.warning("MiniMaxSparseAttn: sol_attn kernel unavailable — model unchanged (dense)")
                return (model,)
        except Exception:
            pass  # CUDA unavailable or kernel absent — dense fallback

        patched = apply_sparse_attention(
            model,
            tau=tau,
            start_percent=start_percent,
            end_percent=end_percent,
            min_tokens=min_tokens,
            dense_blocks=set(),
            extra_tokens=extra_tokens,
            verbose=verbose,
        )
        return (patched,)


NODE_CLASS_MAPPINGS = {"MiniMaxSparseAttention": MiniMaxSparseAttention}
NODE_DISPLAY_NAME_MAPPINGS = {"MiniMaxSparseAttention": "Model Sparse Attention (Sol-Attn)"}
