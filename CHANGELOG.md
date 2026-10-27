# Changelog

All significant code modifications are tagged with the comment `(fix NNN)` — corresponding
numbers can be used to locate context in source code. This document outlines **release-level**
changes rather than individual micro-edits.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
Versioning: [SemVer](https://semver.org/).

---

## [7.0.0] — Unreleased

### Highlights

- **Process name in Task Manager.** Studio window previously displayed as
  generic "electron", indistinguishable from other Electron apps.
  Now the process is named **MinimaxH3Studio**: `electron.exe` is copied
  to `MinimaxH3Studio.exe` (within the same `dist` folder), with embedded Win32
  version resources — "File Properties" and "Product Name" column display "Minimax H3 Studio"
  instead of `Electron / GitHub, Inc.`. Standard `electron.exe` remains intact:
  `npm install` and `npm run desktop` work as usual. The renamed binary is created automatically
  during `start.bat` and `npm run release`.
- **Full Reset.** Settings → Reset → "Full Reset (All)" wipes all user data:
  generated videos, ComfyUI cache, upscale files and job logs, attachments, chat history,
  prompts, and journal files, while clearing `localStorage`/`sessionStorage`. Settings, LoRA, and
  `config.ini` revert to factory defaults. Models and `custom_nodes` remain untouched.
- **Video + Audio Generation** — two-pass pipeline for MiniMax H3
  (low-res → latent upscale → high-res), H.264 / 24 fps.
- **References** — up to 9 images, up to 3 videos, up to 3 audio tracks (with millisecond
  trimming). Draft mode for fast single-pass generation.
- **Extension** — chain-extending completed videos by N seconds (2s context window,
  56-frame segment overlap).
- **Refine** — re-rendering with identical references at higher resolution (720p–2160p).
- **Tile Upscale** — chunked tiled upscaling (VRAM-saving, prevents downscaling).
- **FPS** — frame interpolation with RIFE VFI and FILM VFI (×2–×4).
- **Upscale (DLSS 5 Visual Enhancer)** — native UI tab:
  Neural Rendering (noise/tone/structure) and RTX VSR (1–4×, optional HDR).
- **LLM Assistant** — backends `standard` (GGUF in `ComfyUI/models/llm/`),
  `bonsai` (Ternary Bonsai 2 27B), and `custom` (custom .gguf). Frame vision
  for video references and prompt generation.
- **Voice Input** — integrated whisper STT (CPU): prompt textarea, assistant chat,
  and prompt editor.
- **Generation Queue** — parallel tasks, state recovery upon restart, auto-cleanup.
- **Custom LoRAs** — addition, deletion, and trigger word management.
- **Desktop Application Shell (Electron)** — custom icons, frameless titlebar,
  built-in console dialog, clean termination of all child processes on window exit.
- **Splash Screen** — animated video wall of 8 tiles (`public/splash-videos/`),
  polls ComfyUI backend readiness before entering studio.

### Build Tooling

- `scripts/build.mjs` — production build allocating 8 GB Node heap
  (prevents `JavaScript heap out of memory`).
- `scripts/prune-build.mjs` — compresses compiled bundle: removes `.next/cache/`
  (webpack cache, ~300 MB) and trims `.nft.json` manifests (~530 MB) tracking
  ~87,000 ComfyUI / embedded-Python files. Result: **`.next` shrinks from 841 MB → 8 MB.**
- `scripts/prepare-electron.mjs` — duplicates `electron.exe` to `MinimaxH3Studio.exe`
  and embeds Win32 version resources (ProductName, FileDescription, CompanyName, OriginalFilename).
- `scripts/launch-electron.mjs` — runs studio window via renamed binary with `stdio: 'inherit'`.
- `scripts/clean.mjs` — cleans `.next/`, TypeScript cache, `__pycache__/`, logs, and temporary files.
- `scripts/release.mjs` — full release cycle (clean → typecheck → build → prune → prepare → verify).
- `scripts/make-icons.mjs` — regenerates app icons from `public/logo.svg`.

### Codebase Health

- `tsconfig.json` — enabled `noUnusedLocals` and `noUnusedParameters`.
- `package.json` — added release metadata (`description`, `engines`, `license`) and scripts (`check`, `clean`, `release`).

### Fixed

- **Model sizes in registry were inflated by ~7%.** In `models-config.ts`
  expected size was calculated as binary gigabytes (`gb(N)` = N × 2³⁰), while
  HuggingFace reported decimal gigabytes (10⁹). Fixed by using exact byte counts
  matching `content-length` from servers.
- **Outdated build in release directory.** Removed stale `.next/` bundle
  compiled on another workstation. Builds now execute against current source.
- **Duplicate video files in `public/`.** Removed duplicate splash video copies in root `public/`.
- **Project backup directory in release folder.** Excluded `.backup-before-fixes/` from repository.
- **Dead API routes.** Removed 5 unused routes:
  `/api/comfy/refine/plan`, `/api/comfy/copy-to-input`, `/api/config/check`,
  `/api/loras/reset-patches`, `/api/stt/ensure` alongside orphaned `planChunks`.
- **Browser console spam.** Removed 11 extraneous `console.log` statements in client components.
- **Dead code removal.** Cleared unused helper exports, dead imports, and obsolete resolution helpers in Extend tab.
- **Legacy Gradio layer in Upscale.** Cleaned out old Gradio files (`upscale/app.py`, `upscale/start.bat`, and 31 legacy modules).
- **Bloated build.** Added `prune-build.mjs` reducing `.next` output from 841 MB to 8 MB.
- **Custom LLM file validation.** Validates `.gguf` / `.mmproj` file extensions and rejects invalid paths upfront.
- **Custom LLM subfolder discovery.** Scans 2 levels deep when selecting model directory.
- **Error messaging.** Surfaced backend error messages clearly in settings UI.
- **STT folder validation.** Checks that non-empty `stt.dir` exists.
- **Model migration safeguards.** Prevents active models directory from being selected as migration source.
- **External model paths.** Validates full subpaths for models located in external directories.
- **Documentation.** Synced README to actual directory layout and configurations.
- **Model size labels.** Dynamically derives size labels from `models-config.ts`.
- **Tutorial & guide copy.** Updated outdated references in Learn view.

### Video Comparison in Gallery (fixes 728–729)

- **Ctrl+click two video cards** (⌘ on Mac) to select for comparison: displays **A** / **B** badges.
  Toolbar shows **"Compare"** button and clear action (×).
- **Fullscreen slider dialog** (`video-compare-dialog.tsx`, modal portal):
  two overlapping videos with draggable split curtain. Supports keyboard and touch dragging.
- **Two playback modes**: "Video" (synchronized playback) and "Frame" (step-by-step scrubbing).
- Supported across **all tabs containing the gallery**.

### Gallery Folders on Re-use (fix 727)

- **Refine, FPS, Tile Upscale, Face Refine, and Extend place results into the source video's folder.**
- **Upscale (DLSS 5) now preserves subfolders too.** Imported gallery videos remember their folder,
  and rendered outputs move to that folder alongside `.meta.json`.
- **ControlNet output folder selection** matching the Generate tab.

### Face Refine (fix 722)

- **Face Refine tab** — local re-rendering of small faces in completed videos.
  Extracts face crops, re-generates at 512 canvas with low denoise, and blends back
  with feathered color matching.
- **Subject selection methods**:
  * Rule-based (Largest, Closest to center, Leftmost/Rightmost, Smallest);
  * **Interactive click on face in source frame** (with frame scrubber);
  * **Reference photo matching** via insightface embedding.
- **Live generation preview** via `ModelPreviewOverrideKJ`.
- **Distant shots human detector** (`person_yolov8m-seg` fallback).
- Result saves to gallery with "Face Refine" badge and full metadata.

### Metadata (fix 722)

- **Sidecar merging.** Merges pending and client metadata safely without overwriting fields.
- **Reference array preservation.** Preserves roles and trimming properties per item.
- **Complete parameter logging.** Captures pipeline, sampler, Veda, Sol-Attn, and effective geometries.
- **Accurate trim metadata.** Probed resolution and durations for trimmed videos.
- **Rerun fidelity.** Restores draft mode pipelines accurately from metadata.

### Card Badges

- Distinct hierarchy for card badges: Edit → DLSS 5 → Upscale → Extend → Tile → ControlNet → Refine → FPS → Draft.

### Known Limitations

- Requires NVIDIA GPU (12+ GB VRAM recommended, 8 GB minimum) and CUDA 12.x driver.
- Live real-time HLS streaming is not part of this studio package.
- ESLint is not included; run `npm run typecheck` for static analysis.
