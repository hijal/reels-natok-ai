# Dependency Installer

Restores the studio's working environment on a clean Windows x64 machine.
Launched with a single file `install.bat` at the project root.

## What it does

| Step | What it installs |
| --- | --- |
| 1 | Checks: Windows x64, free disk space, internet, NVIDIA driver |
| 2 | Node.js 22 (portable in `runtime\`) — if 18+ is not present on the system |
| 3 | `node_modules` (`npm ci`) + production build `.next` |
| 4 | ComfyUI (build `5f0c4e1` + project patches) + Python **3.12.10** (embedded) |
| 5 | torch **2.11.0+cu130** and 288 pinned-version packages |
| 6 | 22 custom nodes at pinned commits + 4 studio internal nodes |
| 7 | Model directories, `extra_model_paths.yaml`, auto-update lock |
| 8 | ComfyUI test run and verification of all node imports |

**Models are not downloaded.** After installation, run `start.bat` and download
models via the UI: Settings → Models.

## Requirements

- Windows 10/11 x64
- 25 GB free disk space (environment itself is ~12 GB, plus space for models)
- Internet connection: ~9 GB downloaded during installation
- NVIDIA GPU + CUDA 12.x driver (without it the studio will start, but cannot generate)

## Running

```
install.bat
```

Or with parameters (PowerShell):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install\install.ps1 -Force
```

| Parameter | Description |
| --- | --- |
| `-Force` | Reinstall everything from scratch (removes `node_modules`, ComfyUI, nodes, cache) |
| `-SkipApp` | Do not touch Node.js or the app build |
| `-SkipComfy` | Do not touch ComfyUI (Python, packages, nodes) |
| `-KeepCache` | Keep downloaded archives and pip cache |
| `-NoPause` | Do not wait for Enter at the end |
| `-Root <path>` | Custom project root directory |

The script can be run repeatedly: already installed components are skipped,
so it also functions as a "repair" tool after failures.

## What is NOT restored

These folders are not included in git (too large and/or proprietary); the installer
only displays a warning for them:

| Folder | Size | Impact if missing |
| --- | --- | --- |
| `upscale\bin\` | ~1.1 GB | **Upscale** tab (DLSS 5) will not work |
| `stt\` | ~168 MB | **Voice input** will not work |

They need to be copied manually from a working machine: place the folders next to
`start.bat`. Everything else (generation, extension, refine, FPS, Face Refine,
ControlNet, gallery) works without them.

## ComfyUI version and project patches

ComfyUI core is downloaded not from a tag, but from a specific commit
`5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67` (2026-08-25) — the studio's working setup
is built specifically on it (`__version__` remains `0.33.0`).

On top of the core, the installer copies 4 files from `install/comfy-patches/` on every run:

| File | Purpose |
| --- | --- |
| `comfy/ldm/minimax/model.py` | `to_gate_compress` layer for VSA weights, `minimax_h3_layout` and `block_index` for Veda sparse attention |
| `comfy/model_detection.py` | detection of `gate_compress` in VSA checkpoints |
| `comfy_extras/nodes_minimax_h3.py` | keyframe-latent fixes (patches 146/149) + nodes `MiniMaxH3AudioOrSilent` / `MiniMaxH3AudioSliceFrom` (source audio / silence and tail slice — required for refine, face-refine, and extension) |
| `utils/extra_config.py` | list of paths in `extra_model_paths.yaml` (studio writes them as lists) |

The copying is idempotent: re-running the installer restores the patches even if
ComfyUI was already installed or updated.

## Troubleshooting

1. Open `install.log` in the project root — it contains a step-by-step log with error details.
2. Re-run `install.bat`: the script will resume from where it failed.
3. If an error is in a specific node, it can be excluded from `install/nodes.json`
   and installation can be run again.

Common issues:

| Error | Solution |
| --- | --- |
| `Not enough disk space` | Free up disk space or move the project to another drive |
| `No internet access` | Check VPN/proxy, try again |
| `torch cannot be imported` | Retry the step: `pip` might have downloaded a corrupt file, run with `-Force` |
| ComfyUI failed to start | Check `install.log`: most commonly insufficient permissions or antivirus blocking `python.exe` |

## How to update versions

All versions are pinned across three files:

- `install/requirements.lock.txt` — Python packages (288)
- `install/requirements.sdist.txt` — packages built from source (8)
- `install/nodes.json` — repository + commit for each custom node

To update a node: change `sha` to the target commit and run
`install.bat -Force`.
