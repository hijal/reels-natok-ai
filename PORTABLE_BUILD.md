# Building the Portable Version of MiniMax H3 Studio

This guide is for developers/agents: how to assemble a ready-to-run portable distribution
without user data, prompt history, or heavy model weights.

Target output:

```text
E:\Minimax_Studio_V7_Portable\       — portable build folder (~9.4 GB)
E:\Minimax_Studio_V7_Portable.zip    — zip64 archive (~5.4 GB)
```

H3 models, VAE, LoRA, LLM, and other weights **are not bundled**. They
are downloaded by the user via "Settings → Models" upon first launch.
Configuration defaults: factory preset, `vram_headroom=2`.

---

## 1. Critical Pitfalls

### 1.1. Do not exclude `data` and `models` by folder name

`robocopy /XD data` or `/XD models` excludes **all** directories with that name,
including:

- `node_modules/caniuse-lite/data` → breaks `next build`;
- `python_embeded/.../torchvision/models` → breaks ComfyUI import;
- `custom_nodes/.../models` → breaks custom nodes.

Exclude only **exact full paths**:

```powershell
$comfySrc = Join-Path $src 'ComfyUI-Easy-Install'
# ...
(Join-Path $comfySrc 'ComfyUI\models')
(Join-Path $comfySrc 'ComfyUI\user')
```

### 1.2. Build `.next` directly inside the portable folder

Next.js writes absolute `resolvedPagePath` values into `.next/server/...`. If built
in `E:\Minimax_Studio_V7` and copied over, paths will point to the source folder.
Therefore:

1. Copy the project and `node_modules`;
2. Run `npm run build` **inside** the portable destination folder;
3. Execute `scripts/prune-build.mjs`.

### 1.3. `--quick-test-for-ci` generates user data

Testing ComfyUI creates `ComfyUI/user/...`, log files, and `comfyui.db`.
Before archiving, always clean `ComfyUI/user`, `input`, `output`, `temp`,
and the root `data` directory.

### 1.4. Do not use `Compress-Archive` for archives >2 GB

PowerShell 5's `Compress-Archive` can fail on large files. Use
built-in `tar.exe` (bsdtar, supports zip64):

```powershell
tar.exe -a -c -f $zip -C (Split-Path $dst -Parent) (Split-Path $dst -Leaf)
```

### 1.5. Both `ffmpeg.exe` and `ffprobe.exe` are required

`video-probe.ts` executes `ffprobe.exe`, and `resolveFfprobe()` looks for it **alongside**
`ffmpeg.exe` returned by `resolveFfmpeg()`. `imageio_ffmpeg` contains
only `ffmpeg.exe` — without `ffprobe.exe` refine, tile-upscale, and FPS fail:

```text
spawn ffprobe.exe ENOENT
```

Place both binaries in the same folder:

```text
runtime\ffmpeg\ffmpeg.exe
runtime\ffmpeg\ffprobe.exe
```

Take both from the same static FFmpeg build. In this repository the pair already
lives in `runtime\ffmpeg`; if absent — copy from your FFmpeg `bin`.
Having only `ffprobe.exe` without `ffmpeg.exe` will not work: the application resolves
ffmpeg first and only then looks for ffprobe next to it.

### 1.6. FILM VFI — patch for PyTorch 2.11 / cuDNN 9.19

The legacy TorchScript FILM model (`film_net_fp32.pt`) uses
`padding='same'` with an even kernel. On `torch 2.11 + cuDNN 9.19` this results
in native `Fatal Python error: Aborted` in `Convolution.cpp`.

ComfyUI-Easy-Install already includes the patch: FILM is loaded as an
eager `Interpolator` with explicit padding and the same `state_dict`. For a new ComfyUI copy,
reapply:

```powershell
python scripts/patch-film-vfi.py --comfy-root <portable_path>/ComfyUI-Easy-Install/ComfyUI
```

After patching, FILM runs on GPU with matching output to the original
(max diff ~1e-5). Without the patch, use RIFE.

---

## 2. Step-by-Step Build Instructions (PowerShell)

Run in PowerShell. Node/npm in the project reside in `runtime\`, add them
to `PATH`.

Before copying, close any running Electron/ComfyUI instances: Windows
can lock `electron.exe`, `python.exe`, and DLLs. If robocopy reports
locked files — close the studio and retry.

```powershell
$src = 'E:\Minimax_Studio_V7'
$dst = 'E:\Minimax_Studio_V7_Portable'
$zip = 'E:\Minimax_Studio_V7_Portable.zip'

if (Test-Path $dst) { throw "Delete or rename $dst before building" }
New-Item -ItemType Directory -Path $dst | Out-Null

# ── 1. Project root (excluding ComfyUI, data, caches, and logs) ──────
$rootExcl = @(
  (Join-Path $src '.git'),
  (Join-Path $src '.install-cache'),
  (Join-Path $src '.local-input'),
  (Join-Path $src 'data'),
  (Join-Path $src 'install'),
  (Join-Path $src 'ComfyUI-Easy-Install'),
  (Join-Path $src '.next\cache')
)
$rcArgs = @(
  $src, $dst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP',
  '/XD'
) + $rootExcl + @('.git', '__pycache__', '/XF', '*.log', '*.pyc', 'install.bat')
& robocopy @rcArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy root failed: $LASTEXITCODE" }

# ── 1b. ffmpeg + ffprobe pair (prevents ENOENT in refine/tile/FPS) ────
$ffmpegDst = Join-Path $dst 'runtime\ffmpeg'
$ffmpegOk = (Test-Path (Join-Path $ffmpegDst 'ffmpeg.exe')) -and
            (Test-Path (Join-Path $ffmpegDst 'ffprobe.exe'))
if (-not $ffmpegOk) {
  $ffmpegBin = $env:FFMPEG_BIN
  if (-not $ffmpegBin) {
    throw 'Missing runtime\ffmpeg\ffmpeg.exe + ffprobe.exe. Place pair in runtime\ffmpeg or set $env:FFMPEG_BIN=C:\ffmpeg\bin'
  }
  New-Item -ItemType Directory -Force -Path $ffmpegDst | Out-Null
  Copy-Item (Join-Path $ffmpegBin 'ffmpeg.exe')  (Join-Path $ffmpegDst 'ffmpeg.exe')  -Force
  Copy-Item (Join-Path $ffmpegBin 'ffprobe.exe') (Join-Path $ffmpegDst 'ffprobe.exe') -Force
}

# ── 2. Factory config.ini and .env from HEAD (do not copy user configs) ──
foreach ($f in @('config/config.ini', '.env')) {
  $factory = & git -C $src show "HEAD:$f"
  if ($LASTEXITCODE -ne 0) { throw "git show $f failed" }
  $out = Join-Path $dst $f
  New-Item -ItemType Directory -Force -Path (Split-Path $out -Parent) | Out-Null
  [IO.File]::WriteAllLines($out, $factory, [Text.UTF8Encoding]::new($false))
}

# ── 3. ComfyUI-Easy-Install (excluding models and user folders) ────────
$comfySrc = Join-Path $src 'ComfyUI-Easy-Install'
$comfyDst = Join-Path $dst 'ComfyUI-Easy-Install'
$comfyExcl = @(
  (Join-Path $comfySrc 'ComfyUI\models'),
  (Join-Path $comfySrc 'ComfyUI\user'),
  (Join-Path $comfySrc 'ComfyUI\input'),
  (Join-Path $comfySrc 'ComfyUI\output'),
  (Join-Path $comfySrc 'ComfyUI\temp'),
  (Join-Path $comfySrc 'ComfyUI\tests'),
  (Join-Path $comfySrc 'ComfyUI\tests-unit'),
  (Join-Path $comfySrc 'ComfyUI\.ci'),
  (Join-Path $comfySrc 'ComfyUI\.github')
)
$rcArgs = @(
  $comfySrc, $comfyDst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP',
  '/XD'
) + $comfyExcl + @('.git', '__pycache__', '/XF', '*.log', '*.pyc')
& robocopy @rcArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy comfy failed: $LASTEXITCODE" }

# ── 4. Models directory structure without weights ─────────────────────
$modelsSrc = Join-Path $comfySrc 'ComfyUI\models'
$modelsDst = Join-Path $comfyDst 'ComfyUI\models'
$rcArgs = @(
  $modelsSrc, $modelsDst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NP',
  '/XD', '__pycache__', '.git',
  '/XF', '*.safetensors', '*.ckpt', '*.pt', '*.pth', '*.onnx', '*.bin', '*.gguf',
  '*.sft', '*.engine', '*.pkl', '*.npz', '*.npy', '*.h5', '*.msgpack', '*.log', '*.pyc'
)
& robocopy @rcArgs
if ($LASTEXITCODE -ge 8) { throw "robocopy models failed: $LASTEXITCODE" }

# ── 5. Empty user directories ─────────────────────────────────────────
$dirs = @(
  'data',
  'data\chat-attachments',
  'data\upscale-input',
  'data\upscale-output',
  'ComfyUI-Easy-Install\ComfyUI\input',
  'ComfyUI-Easy-Install\ComfyUI\output',
  'ComfyUI-Easy-Install\ComfyUI\temp',
  'ComfyUI-Easy-Install\ComfyUI\user',
  'upscale\logs',
  'upscale\jobs'
)
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $dst $d) | Out-Null }

# ── 6. Build inside portable directory ────────────────────────────────
$node = Join-Path $dst 'runtime\node.exe'
$npm  = Join-Path $dst 'runtime\npm.cmd'
$env:PATH = (Join-Path $dst 'runtime') + ';' + $env:PATH
Push-Location $dst
try {
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  & $node scripts\prune-build.mjs
  if ($LASTEXITCODE -ne 0) { throw 'prune-build failed' }
} finally {
  Pop-Location
}
```

### Verification After Copying and Building

```powershell
$src = 'E:\Minimax_Studio_V7'
$dst = 'E:\Minimax_Studio_V7_Portable'
$py  = Join-Path $dst 'ComfyUI-Easy-Install\python_embeded\python.exe'
$node = Join-Path $dst 'runtime\node.exe'

# 1) Key files check
$must = @(
  'start.bat',
  'server.js',
  '.next\BUILD_ID',
  'node_modules\electron\dist\MinimaxH3Studio.exe',
  'node_modules\caniuse-lite\data\browsers.js',
  'runtime\ffmpeg\ffmpeg.exe',
  'runtime\ffmpeg\ffprobe.exe',
  'ComfyUI-Easy-Install\python_embeded\python.exe',
  'ComfyUI-Easy-Install\python_embeded\Lib\site-packages\torchvision\models\__init__.py',
  'ComfyUI-Easy-Install\ComfyUI\main.py',
  'config\config.ini',
  '.env'
)
foreach ($f in $must) {
  if (!(Test-Path (Join-Path $dst $f))) { throw "Missing file: $f" }
}

# 2) Python dependencies
& $py -c "import torch, cv2, torchvision; from torchvision import models; print('torchvision ok')"
if ($LASTEXITCODE -ne 0) { throw 'python imports failed' }

# 2b) ffmpeg/ffprobe
& (Join-Path $dst 'runtime\ffmpeg\ffmpeg.exe') -version | Select-Object -First 1
& (Join-Path $dst 'runtime\ffmpeg\ffprobe.exe') -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw 'ffmpeg/ffprobe failed' }

# 3) ComfyUI loads all custom nodes
& $py -I (Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI\main.py') --quick-test-for-ci
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI quick test failed' }

# 4) Clean user data created by quick test
$comfy = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI'
foreach ($d in @('user', 'input', 'output', 'temp')) {
  Get-ChildItem (Join-Path $comfy $d) -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
}
Get-ChildItem (Join-Path $dst 'data') -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
```

### Smoke Test of Web Server (without launching Electron or second ComfyUI)

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$env:PORT = '3002'
$p = Start-Process -FilePath (Join-Path $dst 'runtime\node.exe') `
  -ArgumentList 'server.js' -WorkingDirectory $dst -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Seconds 4
  $cfg = Invoke-RestMethod 'http://127.0.0.1:3002/api/config'
  if ($cfg.vram_headroom -ne 2) { throw "vram_headroom=$($cfg.vram_headroom), expected 2" }

  $loras = Invoke-RestMethod 'http://127.0.0.1:3002/api/loras'
  if ($null -eq $loras.loras) { throw '/api/loras did not return loras' }

  $root = Invoke-WebRequest 'http://127.0.0.1:3002/' -UseBasicParsing
  if ($root.StatusCode -ne 200) { throw "root HTTP $($root.StatusCode)" }

  try {
    Invoke-WebRequest 'http://127.0.0.1:3002/api/comfy/inpaint' -UseBasicParsing | Out-Null
    throw 'Inpaint route still exists'
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  }
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
Remove-Item Env:PORT -ErrorAction SilentlyContinue
```

After the smoke test, clean user directories once more (server may have created
`data`, `ComfyUI/user`, and temporary files):

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$comfy = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI'
foreach ($d in @('user', 'input', 'output', 'temp')) {
  Get-ChildItem (Join-Path $comfy $d) -Force -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
}
Get-ChildItem (Join-Path $dst 'data') -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Remove-Item (Join-Path $dst '.next\cache') -Recurse -Force -ErrorAction SilentlyContinue
```

---

## 3. Verifying Cleanliness of the Build

Before packaging, ensure there is no user data or weights that should be
downloaded by the end user:

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$models = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI\models'
$comfy  = Join-Path $dst 'ComfyUI-Easy-Install\ComfyUI'

# Verify no model weights remain in models/ (except insightface/buffalo_l.zip —
# which is a small bundle not managed by the app's model manager).
Get-ChildItem $models -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Extension -in '.safetensors','.ckpt','.pt','.pth','.onnx','.bin','.gguf','.sft','.engine' } |
  Select-Object FullName, Length

# Verify no user files remain
Get-ChildItem (Join-Path $dst 'data') -Recurse -File -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $comfy 'user') -Recurse -File -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $comfy 'input') -Recurse -File -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $comfy 'output') -Recurse -File -ErrorAction SilentlyContinue
```

Expected result: empty. Exceptions:

- `models/insightface/models/buffalo_l.zip` — may remain if FaceRefine is desired out of box;
- Weights inside `ComfyUI/custom_nodes/...` (RIFE, FILM, depth) — may remain
  so FPS/ControlNet work without extra setup;
- `models/configs/*.yaml`, `models/fonts/*` — configuration/fonts, keep them.

Also verify factory configuration:

```powershell
Get-Content (Join-Path $dst 'config\config.ini') | Select-String 'vram_headroom|comfy_dir|extra_paths'
```

Must have `vram_headroom=2`, `comfy_dir` empty or unset, `extra_paths=[]`.

---

## 4. Packaging

```powershell
$dst = 'E:\Minimax_Studio_V7_Portable'
$zip = 'E:\Minimax_Studio_V7_Portable.zip'
Remove-Item $zip -Force -ErrorAction SilentlyContinue

tar.exe -a -c -f $zip -C (Split-Path $dst -Parent) (Split-Path $dst -Leaf)
if ($LASTEXITCODE -ne 0) { throw "tar failed: $LASTEXITCODE" }
```

Archive inspection:

```powershell
$zip = 'E:\Minimax_Studio_V7_Portable.zip'
& tar.exe -tf $zip | Select-String @(
  'Minimax_Studio_V7_Portable/start\.bat$',
  'Minimax_Studio_V7_Portable/server\.js$',
  'Minimax_Studio_V7_Portable/\.next/BUILD_ID$',
  'Minimax_Studio_V7_Portable/node_modules/electron/dist/MinimaxH3Studio\.exe$',
  'Minimax_Studio_V7_Portable/node_modules/caniuse-lite/data/browsers\.js$',
  'Minimax_Studio_V7_Portable/ComfyUI-Easy-Install/python_embeded/Lib/site-packages/torchvision/models/__init__\.py$'
)
```

The archive **must not contain**:

- `ComfyUI-Easy-Install/ComfyUI/user/...` files;
- `ComfyUI-Easy-Install/ComfyUI/input|output|temp` files;
- `data/assistant-chats.json`, `data/inflight-generate.json`, `data/loras.json`;
- `ComfyUI-Easy-Install/ComfyUI/models/**/*.safetensors` and other heavy H3 weights.

Target sizes:

```text
Folder  ~9.4 GB
Zip     ~5.4 GB
```

If your cloud storage provider limits files to 5 GB, upload folder directly or split zip into volumes.
With `ffmpeg.exe` + `ffprobe.exe` included, the zip archive exceeds 5 GB.

---

## 5. What is Excluded and Why

- **H3, VAE, LoRA, LLM weights** — downloaded via "Settings → Models".
- **`upscale/bin`** — NVIDIA proprietary DLSS runtime; omitted in open repository.
  `upscale/` is copied as is, so if present in source it will be included;
  if missing, the DLSS/Upscale tab will be disabled. This is by design.
- **User data**: chats, history/starred prompts, `data/loras.json`,
  `ComfyUI/user`, `input`, `output`, logs — not copied.
- **`prompts/`** — application system prompts, kept intact.

---

## 6. Final Checklist

- [ ] `npm run build` executed **inside** `_Portable`.
- [ ] `scripts/prune-build.mjs` executed.
- [ ] `node_modules/caniuse-lite/data/browsers.js` present.
- [ ] `runtime/ffmpeg/ffmpeg.exe` and `runtime/ffmpeg/ffprobe.exe` present, both `-version` commands succeed.
- [ ] `install.bat` and `install/` absent from portable build.
- [ ] `start.bat` prefers `runtime\node.exe`, and falls back to `start /min` if VBS is blocked.
- [ ] `python_embeded/.../torchvision/models/__init__.py` present.
- [ ] `python -c "import torch, cv2, torchvision; from torchvision import models"` passes.
- [ ] `ComfyUI main.py --quick-test-for-ci` passes.
- [ ] Cleaned `ComfyUI/user`, `input`, `output`, `temp`, `data` after quick-test.
- [ ] Web server on free port serves `/` 200, `/api/config` with `vram_headroom=2`.
- [ ] `/api/comfy/inpaint` returns 404.
- [ ] No H3 model weights in `ComfyUI/models`.
- [ ] `config/config.ini` has factory defaults, `vram_headroom=2`.
- [ ] Zip created via `tar.exe` instead of `Compress-Archive`.
- [ ] Portable folder and zip **not** added to git.
