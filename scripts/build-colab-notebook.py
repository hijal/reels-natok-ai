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

1. **Runtime → Change runtime type → GPU**, G4 ও High-RAM পাওয়া গেলে নির্বাচন করো। এই configuration-এর জন্য G4 / L4 / A100 বা ভালো GPU, অন্তত 22 GiB reported VRAM ও 45 GiB available host RAM দরকার। এগুলো conservative checks; generation সফল হওয়ার নিশ্চয়তা নয়। GPU-এর আসল নাম নিচে দেখাবে।
2. ওপর থেকে cell-গুলো চালাও। প্রথমে শুধু একটি 5-second scene পরীক্ষা করো।
3. একটি UTF-8 `.txt` গল্প/স্ক্রিপ্ট = একটি episode। `auto-story` mode-এ local Qwen text planner প্রায় 1/2 মিনিটের scene plan বানাবে; ভিডিও model MiniMax H3-ই থাকবে। আগে থেকেই scene অনুযায়ী script লিখলে `scene-paragraphs` mode নাও—প্রতি paragraph এক scene। একাধিক `.txt` = series।
4. একই চরিত্রের PNG/JPG/WebP reference চাইলে script-এর সঙ্গে upload করো। প্রতিটি দৃশ্যে একই references যাবে।

**Language: English.** Story plans and spoken dialogue use English. Auto-story planner গল্পের adaptation করতে পারে; generation-এর আগে plan দেখে নাও। একই চরিত্র/কণ্ঠ বা dialogue হুবহু আসা নিশ্চিত নয়। Generation preset 576×1024 / 768×1344; final 1080×1920 হলো FFmpeg resize, AI detail enhancement নয়।

এই notebook **Windows UI/Electron/DLSS চালায় না**। এটি official MiniMax H3 weights ও native ComfyUI nodes দিয়ে notebook-এর ভেতরে কাজ করে; public tunnel লাগে না। Colab GPU/RAM/session availability নির্দিষ্ট নয়। GPU inference এই notebook-এর লেখকের local CPU machine-এ যাচাই করা হয়নি।

মডেলগুলো মোট কয়েক দশক GB; local runtime disk-এ থাকবে। Drive-এ শুধু script, reference, completed scenes ও final episode থাকবে। Runtime reset হলে models আবার download হতে পারে।

[Colab FAQ](https://research.google.com/colaboratory/faq.html) · [MiniMax guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) · [Model card / license](https://huggingface.co/Comfy-Org/MiniMax-H3)
""")
code("""#@title 1. Notebook tools প্রস্তুত করো (repository clone লাগবে না)
from pathlib import Path
import sys
TOOLS = Path('/content/reels-natok-tools')
TOOLS.mkdir(parents=True, exist_ok=True)
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
""")
for name in ("assemble_episode.py", "colab_runtime.py", "colab_drama.py", "colab_planner.py"):
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
code("""#@title 7. Settings ও script upload
SCRIPT_MODE = 'auto-story' #@param ['auto-story', 'scene-paragraphs']
TARGET_SECONDS = 60 #@param {type:'slider', min:15, max:120, step:15}
SCENE_SECONDS = 5 #@param {type:'slider', min:5, max:15, step:1}
PRESET = '576x1024' #@param ['576x1024', '768x1344']
FIT = 'pad' #@param ['pad', 'crop']
SEED = 42 #@param {type:'integer'}
CHARACTER_CONTEXT = 'A natural English-language family drama. Keep the same faces, clothing, voices and chosen English accents throughout.' #@param {type:'string'}

from google.colab import files
from colab_drama import plan_script, digest
from colab_planner import plan_story
uploaded = files.upload()  # Select .txt script(s) and optional reference images together.
if SCRIPT_MODE == 'auto-story':
    from colab_runtime import api
    queue = api(URL, '/queue')
    if queue.get('queue_running') or queue.get('queue_pending'):
        raise RuntimeError('Finish or interrupt the current generation before planning another story.')
    api(URL, '/free', {'unload_models': True, 'free_memory': True})
raw_scripts, scripts, REFERENCES = [], [], []
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
    raise ValueError('Upload at least one UTF-8 .txt script')
if len(REFERENCES) > 9:
    raise ValueError('Use at most 9 reference images')
for i, reference in enumerate(REFERENCES, 1):
    print(f'<Picture {i}> = {reference.name}')
for title, text in raw_scripts:
    if SCRIPT_MODE == 'auto-story':
        print('Planning story:', title, '(optional local Qwen model downloads on first use)')
        plan = plan_story(text, title, CHARACTER_CONTEXT, TARGET_SECONDS, SCENE_SECONDS, RUNTIME, WORKSPACE)
    else:
        plan = plan_script(text, title, SCENE_SECONDS, CHARACTER_CONTEXT)
    scripts.append(plan)
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
print('Review the scene plan before running generation. Auto-story adapts your story; scene-paragraphs preserves your scene divisions.')
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
OUTPUTS = []
for plan in scripts:
    output = run_episode(plan, WORKSPACE, RUNTIME, URL, references=REFERENCES,
                         seed=SEED, preset=PRESET, fit=FIT)
    OUTPUTS.append(output)
    print('Episode ready:', output)
print('All requested episodes are complete.')
""")
code("""#@title 10. Preview / download
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
