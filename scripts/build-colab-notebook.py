#!/usr/bin/env python3
"""Build the self-contained notebook from the tested Python helpers."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
cells = []


def markdown(text):
    cells.append({"cell_type": "markdown", "metadata": {}, "source": text.splitlines(True)})


def code(text, hidden=False):
    cells.append({"cell_type": "code", "execution_count": None, "outputs": [],
                  "metadata": {"cellView": "form"} if hidden else {}, "source": text.splitlines(True)})


markdown("""# Reels Natok AI — MiniMax H3

**গল্প/স্ক্রিপ্ট → ছোট দৃশ্য → audio-সহ 1080×1920 episode।**

**Facebook / Instagram Reels output:** সব final video fixed **9:16, Full HD 1080×1920**। Default target **60 seconds (1 minute)**; duration settings থেকে বদলানো যাবে। Model frame rounding-এর কারণে final duration সামান্য বেশি হতে পারে।

1. **Runtime → Change runtime type → GPU**, G4 ও High-RAM পাওয়া গেলে নির্বাচন করো। এই configuration-এর জন্য G4 / L4 / A100 বা ভালো GPU, অন্তত 22 GiB reported VRAM ও 45 GiB available host RAM দরকার। এগুলো conservative checks; generation সফল হওয়ার নিশ্চয়তা নয়। GPU-এর আসল নাম নিচে দেখাবে।
2. ওপর থেকে cell-গুলো চালাও। প্রথমে শুধু একটি 5-second scene পরীক্ষা করো।
3. একটি UTF-8 `.txt` গল্প/স্ক্রিপ্ট = একটি episode। `DRAMA SCRIPT` দিয়ে শুরু হলে supplied one-shot scenes সরাসরি import হবে—Qwen লাগে না। সাধারণ গল্পে `auto-story` local Qwen দিয়ে plan বানাবে। Plain prompt paragraphs হলে `scene-paragraphs` নাও। একাধিক `.txt` = series।
4. একই চরিত্রের PNG/JPG/WebP reference চাইলে script-এর সঙ্গে upload করো। প্রতিটি দৃশ্যে একই references যাবে।

**Language: English.** Story plans and spoken dialogue use English. Auto-story planner গল্পের adaptation করতে পারে; generation-এর আগে plan দেখে নাও। একই চরিত্র/কণ্ঠ বা dialogue হুবহু আসা নিশ্চিত নয়। Generation preset 576×1024 / 768×1344; final 1080×1920 হলো FFmpeg resize, AI detail enhancement নয়।

এই notebook **Windows UI/Electron/DLSS চালায় না**। এটি official MiniMax H3 weights ও native ComfyUI nodes দিয়ে notebook-এর ভেতরে কাজ করে; public tunnel লাগে না। Colab GPU/RAM/session availability নির্দিষ্ট নয়। GPU inference এই notebook-এর লেখকের local CPU machine-এ যাচাই করা হয়নি।

মডেলগুলো মোট কয়েক দশক GB; local runtime disk-এ থাকবে। Drive-এ শুধু script, reference, completed scenes ও final episode থাকবে। Runtime reset হলে models আবার download হতে পারে।

**Auto-disconnect:** Cell 9-এ `AUTO_DISCONNECT = True` default। সব episode save ও verify হলে Drive sync করে GPU/runtime release হবে। Error হলে runtime চালু থাকবে; test scene শেষ হলে disconnect হবে না। Auto mode-এ Drive থেকে final video দেখবে; notebook preview চাইলে checkbox বন্ধ রাখো। Browser tab নিজে বন্ধ হবে না।

[Colab FAQ](https://research.google.com/colaboratory/faq.html) · [MiniMax guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) · [Model card / license](https://huggingface.co/Comfy-Org/MiniMax-H3)
""")
code("""#@title 1. Notebook tools প্রস্তুত করো (repository clone লাগবে না)
from pathlib import Path
import sys
TOOLS = Path('/content/reels-natok-tools')
TOOLS.mkdir(parents=True, exist_ok=True)
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
import importlib
for module in ('colab_finish', 'drama_script', 'colab_planner', 'colab_drama', 'colab_runtime', 'assemble_episode'):
    sys.modules.pop(module, None)
importlib.invalidate_caches()
""")
HELPERS = ("assemble_episode.py", "colab_runtime.py", "colab_drama.py", "colab_planner.py", "drama_script.py", "colab_finish.py")
for name in HELPERS:
    source = (ROOT / "tools" / name).read_text(encoding="utf-8")
    # Plain source is embedded, keeping the notebook usable before any git push.
    code(f"#@title Install helper: {name}\n(TOOLS / {name!r}).write_text({source!r}, encoding='utf-8')\n", hidden=True)
code("""#@title 2. GPU / RAM পরীক্ষা — models download-এর আগে
from colab_runtime import runtime_report, require_runtime
REPORT = runtime_report()
require_runtime(REPORT)
print('Hardware admission checks passed. Actual memory use still depends on generation.')
""")
code("""#@title 3. Google Drive সংযুক্ত করো
from google.colab import drive
drive.mount('/content/drive')
WORKSPACE = Path('/content/drive/MyDrive/reels-natok-ai')
WORKSPACE.mkdir(parents=True, exist_ok=True)
RUNTIME = Path('/content/reels-natok-runtime')
RUNTIME.mkdir(parents=True, exist_ok=True)
import shutil
if (WORKSPACE / 'runtime-lock.json').exists():
    shutil.copyfile(WORKSPACE / 'runtime-lock.json', RUNTIME / 'runtime-lock.json')
print('Completed scenes and episodes will be kept in:', WORKSPACE)
""")
code("""#@title 4. Linux ComfyUI backend install
from colab_runtime import install_runtime
COMFY, PYTHON = install_runtime(RUNTIME)
print('Install complete. The existing Colab CUDA PyTorch was retained.')
""")
code("""#@title 5. MiniMax models download (সময় ও disk লাগবে)
from colab_runtime import download_models
from google.colab import userdata
try:
    hf_token = userdata.get('HF_TOKEN')  # Optional Colab secret; never printed.
except Exception:
    hf_token = None
download_models(RUNTIME, token=hf_token)
hf_token = None
shutil.copyfile(RUNTIME / 'runtime-lock.json', WORKSPACE / 'runtime-lock.json')
""")
code("""#@title 6. Backend চালু করো
from colab_runtime import start_backend
URL = start_backend(RUNTIME)
print('Backend log:', RUNTIME / 'comfy.log')
""")
markdown("""### Start with a logline
Cell 7-এ `LOGLINE`-এ 1–3 sentence English idea লেখো, `EPISODE_TITLE` দাও এবং `auto-story` রাখো। AI scene ও short English dialogue লিখবে। Reference images বা series-এর .txt দিতে চাইলে `UPLOAD_FILES` চালু করো। Logline খালি রাখলে আগের মতো file upload হবে।
""")
code("""#@title 7. Logline / story settings
SCRIPT_MODE = 'auto-story' #@param ['auto-story', 'scene-paragraphs', 'structured-script']
EPISODE_TITLE = 'The Last Slice - S01E01' #@param {type:'string'}
LOGLINE = '' #@param {type:'string'}
UPLOAD_FILES = False #@param {type:'boolean'}
TARGET_SECONDS = 60 #@param {type:'slider', min:15, max:120, step:15}
SCENE_SECONDS = 5 #@param {type:'slider', min:5, max:15, step:1}
PRESET = '576x1024' #@param ['576x1024', '768x1344']
FIT = 'pad' #@param ['pad', 'crop']
SEED = 42 #@param {type:'integer'}
CHARACTER_CONTEXT = '' #@param {type:'string'}

print(f'Reels export: fixed 9:16, 1080x1920. Story target: {TARGET_SECONDS} seconds (default 60; adjustable).')

from google.colab import files
from colab_drama import plan_script, digest
from colab_planner import plan_story
from drama_script import is_drama_script, parse_drama_script
if LOGLINE.strip() and SCRIPT_MODE != 'auto-story':
    raise ValueError('Use auto-story mode to expand a logline into scenes.')
uploaded = files.upload() if UPLOAD_FILES or not LOGLINE.strip() else {}
raw_scripts, scripts, REFERENCES = [], [], []
if LOGLINE.strip():
    if not EPISODE_TITLE.strip():
        raise ValueError('Enter an episode title for your logline.')
    text = LOGLINE.strip()
    raw_scripts.append((EPISODE_TITLE.strip(), text))
    folder = WORKSPACE / 'scripts'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / (digest({'title': EPISODE_TITLE.strip(), 'text': text})[:16] + '-logline.txt')).write_text(text, encoding='utf-8')
for filename, content in sorted(uploaded.items()):
    suffix = Path(filename).suffix.lower()
    if suffix == '.txt':
        if len(content) > 2 * 1024 * 1024:
            raise ValueError('Script must be under 2 MiB')
        raw_scripts.append((Path(filename).stem, content.decode('utf-8-sig')))
        folder = WORKSPACE / 'scripts'
    elif suffix in ('.png', '.jpg', '.jpeg', '.webp'):
        if len(content) > 20 * 1024 * 1024:
            raise ValueError('Reference image must be under 20 MiB')
        folder = WORKSPACE / 'references'
    else:
        print('Skipped unsupported file:', filename)
        continue
    folder.mkdir(parents=True, exist_ok=True)
    import hashlib
    target = folder / (hashlib.sha256(content).hexdigest()[:16] + '-' + Path(filename).name)
    target.write_bytes(content)
    if suffix != '.txt':
        REFERENCES.append(target)
if not raw_scripts:
    raise ValueError('Enter a logline or upload at least one UTF-8 .txt story/script')
if len(REFERENCES) > 9:
    raise ValueError('Use at most 9 reference images')
for i, reference in enumerate(REFERENCES, 1):
    print(f'<Picture {i}> = {reference.name}')
if SCRIPT_MODE == 'auto-story' and any(not is_drama_script(text) for _, text in raw_scripts):
    from colab_runtime import api
    queue = api(URL, '/queue')
    if queue.get('queue_running') or queue.get('queue_pending'):
        raise RuntimeError('Finish or interrupt the current generation before planning another story.')
    api(URL, '/free', {'unload_models': True, 'free_memory': True})
for title, text in raw_scripts:
    if is_drama_script(text) or SCRIPT_MODE == 'structured-script':
        print('Importing supplied scene plan:', title, '(Qwen is skipped)')
        plan = parse_drama_script(text, context=CHARACTER_CONTEXT)
    elif SCRIPT_MODE == 'auto-story':
        print('Planning story:', title, '(optional local Qwen model downloads on first use)')
        plan = plan_story(text, title, CHARACTER_CONTEXT, TARGET_SECONDS, SCENE_SECONDS, RUNTIME, WORKSPACE)
    else:
        plan = plan_script(text, title, SCENE_SECONDS, CHARACTER_CONTEXT)
    scripts.append(plan)
    for warning in plan.get('warnings', []):
        print('Import note:', warning)
shutil.copyfile(RUNTIME / 'runtime-lock.json', WORKSPACE / 'runtime-lock.json')
from colab_drama import atomic_json, frame_count
atomic_json(WORKSPACE / 'last-plan.json', {'episodes': scripts, 'references': [str(p) for p in REFERENCES],
    'preset': PRESET, 'fit': FIT, 'seed': SEED})
for plan in scripts:
    actual = sum(frame_count(s['duration']) / 24 for s in plan['scenes'])
    print(f"{plan['title']}: {len(plan['scenes'])} scenes, about {actual:.1f}s final duration")
    print('Shared context:', plan['context'])
    for i, scene in enumerate(plan['scenes'], 1):
        print(f"Scene {i}: {scene['prompt']}")
print('Reference names map to <Picture 1>, <Picture 2> etc. Use these tags in your shared context or scenes.')
print('Review the scene plan before generation. Structured scripts preserve their scene durations and dialogue; no Qwen rewrite is used.')
""")
code("""#@title 8. প্রথমে একটি 5-second scene পরীক্ষা করো
from colab_drama import run_episode
smoke = dict(scripts[0], title=scripts[0]['title'] + '-test',
             scenes=[dict(scripts[0]['scenes'][0], duration=5)])
TEST_VIDEO = run_episode(smoke, WORKSPACE / 'tests', RUNTIME, URL,
                         references=REFERENCES, seed=SEED, preset=PRESET, fit=FIT)
from IPython.display import Video, display
display(Video(str(TEST_VIDEO), embed=True, width=270))
print('Check faces, motion, voice and dialogue before spending time on the full episode.')
""")
markdown("""### Full episode
টেস্ট দেখে সন্তুষ্ট হলে পরের cell চালাও। Scenes একে একে generate হবে; শেষে assembly নিজে হবে।
Cell stop করলে backend-এর চলমান scene থামবে না। একই runtime-এ আবার চালালে saved prompt ID-তে যুক্ত হবে। Runtime reset হলে cells 1–6 চালিয়ে নিচের resume cell ব্যবহার করো। একই script/settings রাখলে শেষ হওয়া scenes আবার generate হবে না।
""")
code("""#@title 9. Generate এবং auto-assemble সব episode
AUTO_DISCONNECT = True #@param {type:'boolean'}
from colab_finish import finish_run
OUTPUTS = []
for plan in scripts:
    output = run_episode(plan, WORKSPACE, RUNTIME, URL, references=REFERENCES,
                         seed=SEED, preset=PRESET, fit=FIT)
    OUTPUTS.append(output)
    print('Episode ready:', output)
print('All requested episodes are complete.')
finish_run(OUTPUTS, WORKSPACE, expected_episodes=len(scripts), auto_disconnect=AUTO_DISCONNECT)
""")
code("""#@title 10. Preview / download (AUTO_DISCONNECT বন্ধ রাখলে)
from IPython.display import Video, display
for output in OUTPUTS:
    print(output)
    display(Video(str(output), embed=True, width=270))
DOWNLOAD_LAST = False #@param {type:'boolean'}
if DOWNLOAD_LAST and OUTPUTS:
    files.download(str(OUTPUTS[-1]))
""")
code("""#@title Optional: reconnect-এর পর saved plan restore (cells 1–6 চালানোর পরে)
import json
saved = json.loads((WORKSPACE / 'last-plan.json').read_text(encoding='utf-8'))
scripts = saved['episodes']
REFERENCES = [Path(p) for p in saved['references']]
PRESET, FIT, SEED = saved['preset'], saved['fit'], saved['seed']
from colab_drama import run_episode
print('Saved plan restored. Run cell 9 to resume.')
""")
code("""#@title Optional: চলমান generation বন্ধ করো (শুধু এই runtime)
STOP_CURRENT = False #@param {type:'boolean'}
if STOP_CURRENT:
    from colab_runtime import api
    api(URL, '/interrupt', {})
    print('Interrupt requested. Completed scenes remain on Drive.')
""")
example = (ROOT / "colab/drama.example.txt").read_text(encoding="utf-8")
markdown("""## ১ মিনিটের example script
এটি UTF-8 `.txt` হিসেবে save করে cell 7-এ upload করতে পারো। 12টি paragraph, প্রতিটি 5-second scene। Dialogue ছোট রাখো; model হুবহু বলবে এমন নিশ্চয়তা নেই। Character reference upload করলে shared context-এ `<Picture 1>` ইত্যাদির পরিচয় দাও।

```text
""" + example + "\n```\n")
notebook = {"nbformat": 4, "nbformat_minor": 5,
            "metadata": {"colab": {"name": "Reels_Natok_MiniMax_H3.ipynb"},
                         "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
                         "accelerator": "GPU"}, "cells": cells}
for i, cell in enumerate(cells):
    cell["id"] = f"reels-natok-{i:02d}"
destination = ROOT / "colab/Reels_Natok_MiniMax_H3.ipynb"
destination.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"Built {destination.name}: {len(cells)} cells")

# Self-contained repair for an already-running notebook. Keep sources generated
# from the same helpers so users do not need to restart or redownload weights.
repair = '''"""Run in the existing Colab notebook's globals after uploading this repair file."""
from pathlib import Path
import sys
import importlib
import shutil

TOOLS = Path(globals().get('TOOLS', '/content/reels-natok-tools'))
TOOLS.mkdir(parents=True, exist_ok=True)
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
'''
for name in HELPERS:
    repair += f"(TOOLS / {name!r}).write_text({(ROOT / 'tools' / name).read_text(encoding='utf-8')!r}, encoding='utf-8')\n"
repair += '''
for module in ('colab_finish', 'drama_script', 'colab_planner', 'colab_drama', 'colab_runtime', 'assemble_episode'):
    sys.modules.pop(module, None)
importlib.invalidate_caches()
from colab_drama import plan_script, run_episode, atomic_json, frame_count
from colab_planner import plan_story
from drama_script import is_drama_script, parse_drama_script

sources = list(globals().get('raw_scripts', []))
if not sources:
    for filename, content in globals().get('uploaded', {}).items():
        if Path(filename).suffix.lower() == '.txt':
            sources.append((Path(filename).stem, content.decode('utf-8-sig')))
if not sources:
    raise RuntimeError('Helpers updated. Rerun the script upload cell; structured scripts now bypass Qwen automatically.')
if any(not is_drama_script(text) for _, text in sources):
    raise RuntimeError('Helpers updated. For unstructured stories, rerun the upload cell. Any planner error will now include its actual traceback and planner.log path.')
if 'WORKSPACE' not in globals() or 'RUNTIME' not in globals():
    raise RuntimeError('Connect Drive and restore WORKSPACE/RUNTIME before applying this repair.')
scripts = [parse_drama_script(text, context=globals().get('CHARACTER_CONTEXT', '')) for _, text in sources]
REFERENCES = [Path(p) for p in globals().get('REFERENCES', [])]
PRESET = globals().get('PRESET', '576x1024')
FIT = globals().get('FIT', 'pad')
SEED = globals().get('SEED', 42)
atomic_json(Path(WORKSPACE) / 'last-plan.json', {'episodes': scripts, 'references': [str(p) for p in REFERENCES],
    'preset': PRESET, 'fit': FIT, 'seed': SEED})
if (Path(RUNTIME) / 'runtime-lock.json').exists():
    shutil.copyfile(Path(RUNTIME) / 'runtime-lock.json', Path(WORKSPACE) / 'runtime-lock.json')
for plan in scripts:
    actual = sum(frame_count(s['duration']) / 24 for s in plan['scenes'])
    print(f"Imported {plan['title']}: {len(plan['scenes'])} scenes; {plan['planned_seconds']:g}s planned, about {actual:.1f}s after H3 frame snapping.")
    for warning in plan.get('warnings', []):
        print('Import note:', warning)
print('Repair complete. No Qwen invocation or model download was needed. Run the existing scene-test cell (8), then full generation (9).')
'''
(ROOT / "colab/repair-script-upload.py").write_text(repair, encoding="utf-8")
print("Built repair-script-upload.py for existing Colab sessions")
