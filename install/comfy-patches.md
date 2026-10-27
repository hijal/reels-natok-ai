# ComfyUI Core Patches

Files from the `comfy-patches/` directory are copied over the downloaded
ComfyUI by the installer on every run (step 4, idempotent).

Base build: commit
`5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67` (2026-08-25, `__version__ = "0.33.0"`).

| File | Changes |
| --- | --- |
| `comfy/ldm/minimax/model.py` | `to_gate_compress` in `Attention` (VSA weights), `minimax_h3_layout` and `block_index` in `transformer_options` for Veda sparse attention |
| `comfy/model_detection.py` | detects `gate_compress` in VSA checkpoints |
| `comfy_extras/nodes_minimax_h3.py` | keyframe-latent: latent recalculation when switching resolutions (patches 146/149); nodes `MiniMaxH3AudioOrSilent` (source audio or silence) and `MiniMaxH3AudioSliceFrom` (slice starting at second / tail of the last N seconds) — required for refine, face-refine, and extension |
| `utils/extra_config.py` | accepts lists of paths in `extra_model_paths.yaml` (studio writes them as lists) |

The files are full copies from the working setup rather than diff patches, so installation does not depend on `git`/`patch` being available on the machine.

When updating ComfyUI, these files should be ported to the new base and updated here.
