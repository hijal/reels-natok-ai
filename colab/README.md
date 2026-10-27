# MiniMax H3 drama on Google Colab

Facebook / Instagram Reels output is always **9:16, Full HD 1080×1920 MP4**.
The default story target is **60 seconds (1 minute)**, with adjustable duration.
This is the project's starting target, not a claim that one length performs best
for every reel. Model frame rounding can make the final export slightly longer;
structured scripts keep their supplied scene durations.

Open **[Reels_Natok_MiniMax_H3.ipynb](Reels_Natok_MiniMax_H3.ipynb)** in
[Google Colab](https://colab.research.google.com/) using **File → Upload notebook**.
The notebook embeds its Python helpers, so it works without cloning this repository
or publishing these changes first. Nothing needs to run on the local AMD machine.

The Windows installer and browser launcher are not used. This notebook
installs a separate Linux ComfyUI backend, uses official MiniMax H3 Ref2VA weights,
and runs native ComfyUI nodes through loopback HTTP. It does not expose a tunnel or
require the studio's Windows custom-node patches or DLSS. An optional
local Qwen text planner adapts unstructured stories before MiniMax generation.

## Quick start

1. Colab-এ GPU runtime ও High-RAM নাও। **G4 পেলে সেটাই নির্বাচন করো**;
   notebook আসল GPU model, VRAM, RAM এবং CUDA kernel compatibility দেখাবে।
2. Cells 1–6 চালিয়ে tools, Drive, backend ও models প্রস্তুত করো। Model download
   কয়েক দশক GB; প্রথম setup-এ সময় লাগবে। Model access চাইলে Colab Secrets-এ
   `HF_TOKEN` রাখো; token notebook বা Git-এ লিখবে না।
3. Cell 7-এ `auto-story` mode রাখো। `LOGLINE`-এ ছোট English idea paste করো,
   `EPISODE_TITLE` দাও। Target duration default 60 seconds; চাইলে বদলাও। Scene বা dialogue
   নিজে লিখতে হবে না। [The Last Slice logline](the-last-slice-s01e01.logline.txt)
   সরাসরি paste করতে পারো। Local text planner scene plan তৈরি করবে।
   File দিয়ে করতে চাইলে `LOGLINE` খালি রেখে গল্প/স্ক্রিপ্ট `.txt` upload করো। এক
   `.txt` = এক episode; একাধিক `.txt` = series। `DRAMA SCRIPT` দিয়ে শুরু হওয়া
   one-shot structured scripts নিজে detect হবে—Qwen download/rewriting লাগে না।
   Plain prompt paragraphs হলে `scene-paragraphs` নাও—এক paragraph = এক scene।
   [এক মিনিটের example](drama.example.txt) দেওয়া আছে।
4. Logline-এর সঙ্গে reference images দিতে `UPLOAD_FILES` চালু করো। একাধিক
   episode-এর `.txt`-ও upload করা যাবে; logline দেওয়া থাকলে সেটি একটি অতিরিক্ত
   episode হিসেবে গণ্য হবে। Shared context-এ
   `<Picture 1>`, `<Picture 2>` কার ছবি তা লেখো; notebook reference order দেখায়।
5. Cell 8-এ প্রথমে একটি 5-second scene দেখো। পছন্দ হলে cell 9 চালাও—সব scene
   শেষ হলে episode নিজে assemble হবে। Cell 9-এর `AUTO_DISCONNECT = True`
   default: সব episode যাচাই ও Drive sync হওয়ার পরে runtime/GPU release করবে।
   ভিডিও Drive থেকে দেখো। Cell 10-এ preview চাইলে checkbox বন্ধ রাখো।

Outputs: `MyDrive/reels-natok-ai/episodes/<episode-name>-<recipe-hash>/`.
Each folder keeps the scene clips, prompt IDs, recipe, assembly manifest and final
`episode-1080x1920.mp4`. Changing the script, references, seed, preset or pinned
model/code revision creates a separate recipe folder rather than mixing clips.

`auto-story` uses **Qwen2.5-7B-Instruct** locally in the runtime to adapt your story
into a scene plan and shared character descriptions. Its additional weights are
about 15 GB; download occurs on first use. The planner child process exits before
video generation, releasing its GPU allocations. A saved plan is reused on reruns.
Planner output must pass JSON and scene-count validation; malformed output stops
with an error and is retained as `response.txt` for inspection. No scripts are sent
to an external hosted LLM API.

`scene-paragraphs` uses your scene divisions directly, with one short visual moment
per paragraph and concise quoted dialogue. Review auto-generated plans before
video inference: adaptation may alter details. Reference images and shared context
help continuity; identical identity/voice and exact English speech are not
guaranteed. Inspect the smoke test before generating an episode.

Structured `DRAMA SCRIPT` files are detected in either mode. The one-shot importer
keeps supplied scene durations, dialogue, cast descriptions, variants, action/sound
cues and the source title. Invalid input produces a line-numbered error rather
than an LLM rewrite. Multi-shot `SHOT` blocks are currently rejected; use separate
SCENE blocks. REF paths require manual image upload/mapping. Native model timing,
identity and lip-sync fidelity still require the live smoke test.

## Repair an existing Colab session after a planner error

Do not disconnect the runtime or repeat model setup just for this repair.
In the notebook that already has the script uploaded, add a code cell:

```python
from google.colab import files
repair_files = files.upload()  # Select colab/repair-script-upload.py from this project.
exec(compile(repair_files['repair-script-upload.py'], 'repair-script-upload.py', 'exec'), globals())
```

The self-contained [repair file](repair-script-upload.py) updates notebook helpers
and imports the previously uploaded structured script. It restores `scripts` and
`last-plan.json` without a Qwen call, GPU allocation or model download. Continue
with the existing scene test (cell 8) and full generation (cell 9). If the session
has no uploaded script, rerun the upload cell after the helper update instead.

For ordinary stories that still use Qwen, child output is streamed to the notebook
and saved at `WORKSPACE/planner/<request-hash>/planner.log`. A failed planner now
raises an error with that path and the actual traceback tail, instead of only a
generic `CalledProcessError`. The wrapper traceback alone cannot establish whether
the underlying failure was a dependency issue, download error, disk pressure or GPU
memory issue.

## Generation and resume

The default story planning and spoken dialogue language is **English**. Non-English
dialogue is instructed to be translated into English. Reference images do not set
the spoken language. Language-specific recipe/cache versions prevent reusing old
non-English scene results for new English requests.

- MiniMax H3 generates video and audio together. Scenes are submitted sequentially;
  a failed scene stops the run before final assembly.
- Generation presets are **576×1024** and **768×1344**. The final export is exactly
  **1080×1920**, 24 fps, H.264/AAC. This final resize adds no new AI detail.
- H3 frame counts snap to the `17n+5` grid: a requested 5-second scene is 124 frames
  (~5.17 seconds). The notebook prints the expected episode duration before running.
- Default `pad` preserves each whole frame. `crop` fills the output via center crop.
  Cuts are hard cuts. Added subtitles, soundtrack replacement and transitions are
  outside this workflow.
- Scene checkpoints are written to Drive before/after execution. Rerunning an
  interrupted cell reattaches a known prompt or skips its completed scene file.
  A scene lost with a destroyed runtime must be generated again.
- After a runtime reset, run cells 1–6, then **restore saved plan**, then cell 9.
  Original code/model revisions are saved to Drive so completed scenes remain
  reusable. Only the latest uploaded series plan is restored by that cell; older
  scripts, recipes and exports remain on Drive.
- Runtime `/content` is temporary. Models remain there because they exceed a
  typical free Drive quota. Models may need downloading after runtime reset.
- Automatic shutdown runs only after the entire uploaded batch finishes. It checks
  final exports and scene checkpoints, saves `last-results.json`, then flushes and
  unmounts Drive before calling Colab's `runtime.unassign()`. Generation, validation
  or sync failures skip shutdown; the test scene never triggers it. The browser tab
  stays open. Use the updated notebook's cell 9 for this behavior; updating helpers
  alone does not change an older notebook's generation cell.
- Stopping the notebook monitoring cell leaves the backend job running. Use the
  optional interrupt cell to request cancellation. Completed scene files remain.

This is a separate notebook workflow; existing desktop UI generation/extension
behavior is unchanged. GPU inference has **not been executed in this local
CPU-only environment**. CPU assembly and simulated execution/recovery are tested;
actual planner/model imports, GPU kernels, quality, speed and peak memory require the
notebook's live smoke test.

## Standalone assembly

After scene generation, call the helper with clips in story order:

```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path('/content/reels-natok-ai/tools')))
from assemble_episode import assemble

# Call this immediately after your generation loop has produced these files.
assemble(generated_scene_paths, '/content/episode-01.mp4')
```

`generated_scene_paths` is an ordered list of actual MP4 paths returned by the
generator. The helper does not generate scenes or automatically watch a folder.
It works with one scene or many, and needs only Python, FFmpeg and ffprobe.

For existing clips, run:

```sh
python3 tools/assemble_episode.py scene-01.mp4 scene-02.mp4 --output episode-01.mp4
```

For a series, copy `episodes.example.json`, supply your real scene paths and run:

```sh
python3 tools/assemble_episode.py --manifest colab/episodes.json
```

Paths in a manifest are relative to the manifest's directory. Every episode is
exported separately. Clip order follows the list, never filename sorting.

Exports are **1080x1920, 24 fps, H.264/AAC MP4**, with web playback faststart.
Original audio is retained; silent clips receive silence. Default `pad` preserves
the whole image; `--fit crop` fills the portrait frame with a center crop.
Clips use hard cuts; transitions, subtitles and added dialogue are not generated.
Resizing to Full HD does not restore detail absent from the original generation.

Existing exports are protected unless `--overwrite` is supplied. Original scene
files are kept so assembly can be repeated after a notebook interruption. Store
important scenes and exports in mounted Google Drive; `/content` is temporary.

Check CPU assembly without downloading any models:

```sh
python3 -m unittest discover -s tests -v
```

## Runtime constraints

Google's G4 machine family uses NVIDIA RTX PRO 6000 Blackwell Server Edition;
full GPUs have 96 GB VRAM. Allocated capacity still needs checking rather than
inferring it from a runtime label. The notebook targets Ampere or newer, at least
22 GiB reported VRAM and 45 GiB available host RAM (64+ GiB preferable). These are
conservative admission rules for this configuration, **not measured minimums or a
guarantee of success**. Standard T4 sessions are deliberately rejected.

On 60+ GiB GPUs the text encoder uses the normal GPU placement and ComfyUI's
default memory management. Smaller admitted GPUs use CPU text encoding and
`--lowvram`. Existing CUDA-enabled PyTorch is constrained during setup; incompatible
dependency requirements fail instead of silently replacing Colab's CUDA stack.

This notebook uses a pruned **FP8-scaled** Ref2VA checkpoint, the NVFP4 text encoder,
FP16 video VAE, FP32 audio VAE and compatible Ref2V Turbo LoRA. This avoids requiring
the desktop's CUDA 13 INT8 setup. Model filenames, upstream metadata and disk space
are checked before downloading. Reserve at least 15 GiB beyond remaining model
downloads for runtime work/output. Do not select “Download all” in the Windows UI.

The first installation records the fetched ComfyUI commit; model download records
the Hugging Face commit. Reruns reuse those revisions. They are resolved at setup
time rather than advertised as an already GPU-validated dependency lock.

MiniMax H3 generates short clips; longer drama episodes need a scene plan and
sequential generation before assembly. GPU availability, RAM and session lifetime
vary in Colab. The notebook interface should remain the interaction surface for
free managed runtimes rather than exposing the studio through a tunnel.

Sources: [Colab FAQ](https://research.google.com/colaboratory/faq.html),
[MiniMax H3 guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3),
[official model card](https://huggingface.co/Comfy-Org/MiniMax-H3),
[Qwen planner model](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct),
[Google G4 hardware](https://docs.cloud.google.com/compute/docs/accelerator-optimized-machines).

## Maintaining the notebook

Edit the Python helpers in `tools/`, then regenerate the embedded notebook:

```sh
python3 scripts/build-colab-notebook.py
python3 -m unittest discover -s tests -v
```
