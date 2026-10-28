# Reels Natok — Colab Episode Studio

Turn a story or structured drama script into portrait video episodes with native
audio using MiniMax H3 on Google Colab. Open the password-protected browser
dashboard to upload scripts and reference images, review and edit scene plans,
render a test, generate or resume a batch, preview videos and download exports.

The local computer needs only a browser. GPU inference, the optional Qwen story
planner, ComfyUI and FFmpeg run in Colab. This repository no longer includes the
local Next.js studio, Windows installers, voice dictation or DLSS runtime.

## Start the browser studio

1. Upload [Reels_Natok_Web_Studio.ipynb](colab/Reels_Natok_Web_Studio.ipynb) to
   [Google Colab](https://colab.research.google.com/).
2. Select a GPU and High-RAM runtime, then run setup cells 1–6. Hardware admission
   checks run before model downloads. Setup downloads several tens of GB.
3. Run the dashboard helper cells and **7. Open browser studio**. Keep that cell
   running and open its printed HTTPS URL with the printed password.
4. Upload a script or enter a story, review the scene plan and render a five-second
   test. Then choose **Generate / resume batch**.
5. Preview or download completed videos. After a successful batch, **Save & release
   GPU** verifies exports, syncs Google Drive and releases the runtime.

The browser dashboard targets paid Colab with a positive compute-unit balance.
Runtime/session limits still apply. Quick Tunnel needs no Cloudflare account;
an optional named tunnel provides a stable hostname. See the
[full setup and recovery guide](colab/README.md) for runtime requirements, secrets,
reference mapping, reconnecting and resuming.

## Scripts and output

- **Auto story:** the optional Qwen planner expands a logline or story into scenes.
- **DRAMA SCRIPT:** imports supported one-shot scenes directly, preserving supplied
  dialogue, durations and character variants without calling Qwen. See the
  [script standard](final-script.md) and
  [example episode](the-last-slice-s01e01.txt).
- **Prompt paragraphs:** each paragraph becomes a scene.

Final exports are **9:16, 1080×1920, 24 fps, H.264/AAC MP4**. Generation presets
are 576×1024 and 768×1344; final resizing does not add AI detail. Dialogue defaults
to English. Identity, voices, lip sync and exact timing require review of the live
test scene. H3 frame alignment can make scenes slightly longer than requested.

Scripts, references, scene checkpoints and episodes are saved under
`MyDrive/reels-natok-ai/`. Recipe fingerprints prevent mixing outputs from different
plans/settings. Matching completed scenes are reused when resuming. Model weights
stay on temporary Colab disk and may need downloading after a runtime reset.

The [notebook-only workflow](colab/Reels_Natok_MiniMax_H3.ipynb) is also retained
for operating entirely inside Colab. Both notebooks embed the same Python helpers.

## Source layout

```text
colab/                          Notebooks, usage guide, examples and session repair
tools/colab_web.py              Authenticated dashboard API and background workers
tools/colab_web.html            Browser dashboard markup and styles
tools/colab_web_ui.js           Planning, job controls, polling and video previews
tools/colab_tunnel.py           Cloudflare tunnel and notebook lifecycle
tools/colab_runtime.py          Colab GPU checks, ComfyUI setup and model downloads
tools/colab_planner.py          Optional Qwen story planning
tools/drama_script.py           Structured script validation and import
tools/colab_drama.py            Generation, recipe checkpoints and resume
tools/assemble_episode.py       FFmpeg portrait episode assembly
tools/colab_finish.py           Export verification, Drive sync and GPU release
scripts/build-colab-notebook.py Embed current helpers/assets into both notebooks
tests/                         CPU assembly, dashboard and recovery tests
final-script.md                Common drama script standard
```

The backend stays on Colab loopback; only the authenticated dashboard is tunneled.
Long operations run in background workers, so closing the browser leaves jobs
running while the runtime remains alive. Keep notebook passwords and tokens
private; configure them through Colab Secrets.

## Development and verification

No Node.js/npm build is needed. After editing Python helpers or browser assets:

```sh
python3 scripts/build-colab-notebook.py
python3 -m unittest discover -s tests -v
```

The builder regenerates both notebooks and `colab/repair-script-upload.py`.
Tests verify embedded sources, script import, background jobs, HTTP authentication,
media access, cancellation, checkpoint recovery and safe GPU-release sequencing.
Assembly integration tests require FFmpeg and ffprobe; HTTP tests need loopback
socket access. Actual model inference, GPU memory usage and live tunnel connectivity
must be checked in Colab using the test scene.

Standalone assembly of existing scene clips is also available:

```sh
python3 tools/assemble_episode.py scene-01.mp4 scene-02.mp4 --output episode.mp4
```

Original clips are preserved. Existing exports require explicit `--overwrite`.
