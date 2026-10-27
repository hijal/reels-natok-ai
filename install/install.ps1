#Requires -Version 5.1
<#
.SYNOPSIS
    MiniMax H3 Studio - automatic dependency installation.

.DESCRIPTION
    Restores the project environment on a clean Windows x64 machine:
      * Node.js 22 (portable if 18+ is not present on the system)
      * node_modules + production build .next
      * ComfyUI 0.33.0 + Python 3.12.10 + torch 2.11.0+cu130 + 288 packages
      * 22 custom nodes at pinned commits + 3 local nodes
      * model folders, extra_model_paths.yaml, .no-auto-update

    Models are NOT downloaded - they are loaded via the studio UI.
    Folders upscale/bin and stt are not part of the repository and are not
    restored by the installer (see warnings at the end).

.PARAMETER Root
    Project root directory. Default - parent of the install folder.

.PARAMETER Force
    Reinstall everything from scratch (removes node_modules, ComfyUI, nodes, cache).

.PARAMETER SkipApp
    Do not touch Node.js, node_modules, or app build.

.PARAMETER SkipComfy
    Do not touch ComfyUI components (Python, packages, nodes).

.PARAMETER KeepCache
    Keep downloaded archives and pip cache (speeds up repeated installation).

.PARAMETER NoPause
    Do not wait for a key press at the end.
#>
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$Force,
    [switch]$SkipApp,
    [switch]$SkipComfy,
    [switch]$KeepCache,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = [IO.Path]::GetFullPath($Root)
$InstallDir = $PSScriptRoot
$Cache = Join-Path $Root '.install-cache'
$LogFile = Join-Path $Root 'install.log'

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:Python = $null

if ($Force -and (Test-Path $Cache)) {
    Remove-Item $Cache -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- logging ---

function Write-Log {
    param([string]$Message, [string]$Level = 'info')
    $line = '[{0:HH:mm:ss}] {1}' -f (Get-Date), $Message
    $color = 'Gray'
    switch ($Level) {
        'ok'   { $color = 'Green' }
        'warn' { $color = 'Yellow' }
        'err'  { $color = 'Red' }
        'step' { $color = 'Cyan' }
    }
    Write-Host $Message -ForegroundColor $color
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Step { param([int]$N, [int]$Total, [string]$Text) Write-Log '' ; Write-Log ("[{0}/{1}] {2}" -f $N, $Total, $Text) 'step' }
function Info { param([string]$M) Write-Log ("  " + $M) }
function Ok   { param([string]$M) Write-Log ("  [OK] " + $M) 'ok' }
function Warn { param([string]$M) $script:Warnings.Add($M); Write-Log ("  [WARN] " + $M) 'warn' }
function Fail { param([string]$M) $script:Failures.Add($M); Write-Log ("  [ERROR] " + $M) 'err' }

# ------------------------------------------------------------- primitives ---

function Get-Download {
    param([string]$Url, [string]$Dest)
    if ((Test-Path $Dest) -and (Get-Item $Dest).Length -gt 0) {
        Info ("already downloaded: " + (Split-Path $Dest -Leaf))
        return
    }
    $dir = Split-Path -Parent $Dest
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $part = $Dest + '.part'
    if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
    Info ("downloading: " + $Url)
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path $curl) {
        & $curl -L --fail --retry 5 --retry-delay 3 --connect-timeout 30 --progress-bar -o $part $Url
        if ($LASTEXITCODE -ne 0) {
            if (Test-Path $part) { Remove-Item $part -Force -ErrorAction SilentlyContinue }
            throw ('failed to download: ' + $Url)
        }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
    }
    Move-Item -Force $part $Dest
}

function Expand-ZipSafe {
    param([string]$Zip, [string]$Dest)
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
        & $tar -xf $Zip -C $Dest
        if ($LASTEXITCODE -ne 0) { throw ('failed to unpack archive: ' + $Zip) }
    } else {
        Expand-Archive -Path $Zip -DestinationPath $Dest -Force
    }
}

function Invoke-Pip {
    param([string[]]$PipArgs, [string]$Title)
    Info ('pip: ' + $Title)
    & $script:Python @PipArgs
    if ($LASTEXITCODE -ne 0) { throw ('pip exited with an error: ' + $Title) }
}

function Write-TextFileNoBom {
    param([string]$Path, [string]$Content)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Get-Tail {
    param([string]$Path, [int]$Lines = 15)
    if (-not (Test-Path $Path)) { return @() }
    return @(Get-Content $Path -Tail $Lines -ErrorAction SilentlyContinue)
}

# ------------------------------------------------------------------ banner ---

Write-Log ''
Write-Log '  ============================================================'
Write-Log '    MiniMax H3 Studio 7 - dependency installation'
Write-Log '  ============================================================'
Write-Log ''
Write-Log ('  Project directory: ' + $Root)
Write-Log ('  Log:               ' + $LogFile)
if ($Force)     { Write-Log '  Mode:              full reinstallation (-Force)' }
if ($SkipApp)   { Write-Log '  Mode:              without Node.js and build (-SkipApp)' }
if ($SkipComfy) { Write-Log '  Mode:              without ComfyUI (-SkipComfy)' }
Write-Log ''

# ------------------------------------------------------- 1. system checks ---

Step 1 8 'System check'

if (-not [Environment]::Is64BitOperatingSystem) {
    throw '64-bit Windows (x64) required. 32-bit systems are not supported.'
}
Ok 'Windows x64'

$freeGB = $null
try {
    $drive = (Get-Item $Root).PSDrive
    if ($drive) { $freeGB = [math]::Round($drive.Free / 1GB, 1) }
} catch { }

if ($null -ne $freeGB) {
    Info ("free disk space on " + $drive.Name + ": " + $freeGB + " GB")
    if ($freeGB -lt 12) {
        throw ("Insufficient disk space: minimum 12 GB required, free " + $freeGB + " GB.")
    }
    if ($freeGB -lt 25) {
        Warn ("free space " + $freeGB + " GB. 25+ GB recommended: environment takes ~12 GB, plus space for models.")
    } else {
        Ok 'sufficient disk space'
    }
} else {
    Warn 'unable to determine free disk space'
}

try {
    $probe = Invoke-WebRequest -Uri 'https://pypi.org/simple/' -UseBasicParsing -TimeoutSec 20 -Method Head
    if ($probe.StatusCode -ge 200) { Ok 'internet connection available' }
} catch {
    throw 'No internet access (pypi.org). Check connection, VPN/proxy, and try again.'
}

$nvidia = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidia) {
    try {
        $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>$null | Select-Object -First 1)
        Ok ('GPU: ' + $gpu)
    } catch {
        Warn 'nvidia-smi found, but GPU did not respond'
    }
} else {
    Warn 'nvidia-smi not found: NVIDIA driver is not installed. The studio can start, but generation without GPU is not possible.'
}

# ------------------------------------------------------------- 2. Node.js ---

if (-not $SkipApp) {
    Step 2 8 'Node.js'

    $nodeExe = 'node'
    $runtimeDir = Join-Path $Root 'runtime'
    $nodeOk = $false

    $sysNode = Get-Command node -ErrorAction SilentlyContinue
    if ($sysNode) {
        $verText = (& node --version 2>$null)
        if ($verText -match 'v(\d+)\.') {
            $major = [int]$Matches[1]
            if ($major -ge 18) {
                $nodeOk = $true
                $nodeExe = 'node'
                Ok ('System Node.js: ' + $verText)
            } else {
                Warn ('System Node.js ' + $verText + ' is too old, installing portable version')
            }
        }
    } elseif (Test-Path (Join-Path $runtimeDir 'node.exe')) {
        $nodeOk = $true
        $nodeExe = Join-Path $runtimeDir 'node.exe'
        Ok 'found portable runtime\node.exe'
    }

    if (-not $nodeOk) {
        $nodeVersion = '22.20.0'
        $zip = Join-Path $Cache ('node-v' + $nodeVersion + '-win-x64.zip')
        Get-Download ('https://nodejs.org/dist/v' + $nodeVersion + '/node-v' + $nodeVersion + '-win-x64.zip') $zip
        $tmp = Join-Path $Cache 'node-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-ZipSafe $zip $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        Get-ChildItem $inner.FullName -Force | Move-Item -Destination $runtimeDir -Force
        Remove-Item $tmp -Recurse -Force
        $nodeExe = 'node'
        Ok ('Node.js ' + $nodeVersion + ' installed into runtime\')
    }

    $env:PATH = $runtimeDir + ';' + $env:PATH
    $checkVer = (& node --version 2>$null)
    if (-not $checkVer) { throw 'Node.js does not run after installation.' }

    $npmVersion = (& npm.cmd --version 2>$null)
    if (-not $npmVersion) {
        Warn 'npm not found next to Node.js'
        throw 'npm unavailable. Install Node.js 18+ from https://nodejs.org and run installer again.'
    }
    Ok ('npm ' + $npmVersion)
} else {
    Info 'skipped (-SkipApp)'
}

# ------------------------------------------- 3. node_modules and .next build ---

if (-not $SkipApp) {
    Step 3 8 'Node dependencies and production build'

    Push-Location $Root
    try {
        if ($Force -and (Test-Path 'node_modules')) {
            Info 'removing node_modules (-Force)'
            Remove-Item 'node_modules' -Recurse -Force
        }

        if (-not (Test-Path 'node_modules')) {
            Info 'npm ci - installing web dependencies'
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                Warn 'npm ci failed, trying npm install'
                & npm.cmd install --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw 'failed to install node dependencies (npm).' }
            }
            Ok 'node_modules installed'
        } else {
            Ok 'node_modules already in place'
        }

        if ($Force -and (Test-Path '.next')) {
            Info 'removing old .next build (-Force)'
            Remove-Item '.next' -Recurse -Force
        }

        if (-not (Test-Path '.next\BUILD_ID')) {
            Info 'npm run build - Next.js build, takes 2-5 minutes'
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'app build (npm run build) exited with an error.' }
            Ok '.next build ready'
        } else {
            Ok '.next build already exists'
        }
    } finally {
        Pop-Location
    }
} else {
    Info 'skipped (-SkipApp)'
}

# ---------------------------------------------------- 4. ComfyUI and Python ---

$comfyRoot = Join-Path $Root 'ComfyUI-Easy-Install'
$comfyApp = Join-Path $comfyRoot 'ComfyUI'
$pythonDir = Join-Path $comfyRoot 'python_embeded'
$python = Join-Path $pythonDir 'python.exe'
$script:Python = $python

if (-not $SkipComfy) {
    Step 4 8 'ComfyUI (build 5f0c4e1)'

    if ($Force -and (Test-Path $comfyApp)) {
        Info 'removing ComfyUI (-Force)'
        Remove-Item $comfyApp -Recurse -Force
    }

    if (-not (Test-Path (Join-Path $comfyApp 'main.py'))) {
        if (Test-Path $comfyApp) { Remove-Item $comfyApp -Recurse -Force }
        $zip = Join-Path $Cache 'ComfyUI-5f0c4e1.zip'
        Get-Download 'https://github.com/comfyanonymous/ComfyUI/archive/5f0c4e18cb7e98f0e7c46c2c7ce928d641351e67.zip' $zip
        $tmp = Join-Path $Cache 'comfy-extract'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-ZipSafe $zip $tmp
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not (Test-Path $comfyRoot)) { New-Item -ItemType Directory -Force -Path $comfyRoot | Out-Null }
        Move-Item $inner.FullName $comfyApp
        Remove-Item $tmp -Recurse -Force
        Ok 'ComfyUI unpacked'
    } else {
        Ok 'ComfyUI already in place'
    }

    # Project patches on top of ComfyUI core. Applied on every run of the installer,
    # so re-running also fixes an already broken installation.
    # Without them, several MiniMax H3 nodes fail to work:
    #   comfy/ldm/minimax/model.py       - to_gate_compress layer for VSA weights,
    #                                      minimax_h3_layout and block_index for Veda;
    #   comfy/model_detection.py         - gate_compress detection in VSA checkpoints;
    #   comfy_extras/nodes_minimax_h3.py - keyframe-latent fixes (patches 146/149);
    #   utils/extra_config.py            - path lists in extra_model_paths.yaml
    #                                      (studio writes them specifically as lists).
    $patchDir = Join-Path $InstallDir 'comfy-patches'
    if (Test-Path $patchDir) {
        $patched = 0
        Get-ChildItem $patchDir -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($patchDir.Length).TrimStart('\')
            $dest = Join-Path $comfyApp $rel
            $destDir = Split-Path $dest -Parent
            if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
            Copy-Item $_.FullName $dest -Force
            $patched++
        }
        Ok ('project patches applied: ' + $patched + ' core file(s)')
    } else {
        Warn 'folder install\comfy-patches not found: ComfyUI core remains without project patches, H3/VSA nodes may not work.'
    }

    if ($Force -and (Test-Path $pythonDir)) {
        Info 'removing Python environment (-Force)'
        Remove-Item $pythonDir -Recurse -Force
    }

    if (-not (Test-Path $python)) {
        if (Test-Path $pythonDir) { Remove-Item $pythonDir -Recurse -Force }
        $zip = Join-Path $Cache 'python-3.12.10-embed-amd64.zip'
        Get-Download 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' $zip
        Expand-ZipSafe $zip $pythonDir

        $getpip = Join-Path $Cache 'get-pip.py'
        Get-Download 'https://bootstrap.pypa.io/get-pip.py' $getpip
        & $python $getpip --no-warn-script-location
        if ($LASTEXITCODE -ne 0) { throw 'failed to install pip into portable Python.' }
        Ok 'Python 3.12.10 installed'
    } else {
        Ok 'Python already in place'
    }

    # Patch python312._pth on every run (not just during first install).
    # The line ../ComfyUI is mandatory: start.bat launches python with -I flag,
    # which disables adding script folder to sys.path, and without it
    # main.py fails with ModuleNotFoundError: No module named 'comfy'.
    $pth = Get-ChildItem $pythonDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $lines = @(Get-Content $pth.FullName)
        $lines = @($lines | ForEach-Object { $_ -replace '^#\s*import site', 'import site' })
        if (-not ($lines | Where-Object { $_ -match '^Lib[\\/]site-packages' })) {
            $lines = @('Lib\site-packages') + $lines
        }
        if (-not ($lines | Where-Object { $_ -match '^\.\.[\\/]ComfyUI\s*$' })) {
            $lines = @('../ComfyUI') + $lines
        }
        if ($lines -match '^\.\./ComfyUI\s*$') {
            Ok 'python312._pth configured (../ComfyUI + Lib\site-packages)'
        } else {
            Warn 'failed to verify python312._pth'
        }
        [IO.File]::WriteAllLines($pth.FullName, $lines, (New-Object Text.ASCIIEncoding))
    }

    # --- 5. libraries ---
    Step 5 8 'Python libraries (~7 GB, longest step)'

    Invoke-Pip @('-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel', '--no-warn-script-location', '--disable-pip-version-check') 'pip upgrade'

    Invoke-Pip @('-m', 'pip', 'install',
        'torch==2.11.0+cu130', 'torchvision==0.26.0+cu130', 'torchaudio==2.11.0+cu130',
        '--index-url', 'https://download.pytorch.org/whl/cu130',
        '--no-warn-script-location', '--disable-pip-version-check') 'torch 2.11.0+cu130 (~3.5 GB)'
    Ok 'torch installed'

    Invoke-Pip @('-m', 'pip', 'install', '--no-deps', '--no-warn-script-location', '--disable-pip-version-check',
        '-r', (Join-Path $InstallDir 'requirements.lock.txt')) 'main packages (288)'
    Ok 'main packages installed'

    Invoke-Pip @('-m', 'pip', 'install', '--no-deps', '--no-build-isolation', '--no-warn-script-location', '--disable-pip-version-check',
        '-r', (Join-Path $InstallDir 'requirements.sdist.txt')) 'packages without pre-built wheels (8)'
    Ok 'build from source completed'

    $optionalFile = Join-Path $InstallDir 'requirements.optional.txt'
    if (Test-Path $optionalFile) {
        try {
            Invoke-Pip @('-m', 'pip', 'install', '--no-deps', '--no-build-isolation', '--no-warn-script-location', '--disable-pip-version-check', '-r', $optionalFile) 'optional packages'
            Ok 'optional packages installed'
        } catch {
            Warn 'kornia_rs failed to build (requires Rust). Non-critical: kornia works without it, just slightly slower.'
        }
    }

    # --- 6. custom nodes ---
    Step 6 8 'Custom nodes (22 from GitHub + 3 local)'

    $nodesDir = Join-Path $comfyApp 'custom_nodes'
    if (-not (Test-Path $nodesDir)) { New-Item -ItemType Directory -Force -Path $nodesDir | Out-Null }

    $nodes = Get-Content (Join-Path $InstallDir 'nodes.json') -Raw | ConvertFrom-Json
    $idx = 0
    foreach ($node in $nodes) {
        $idx++
        $target = Join-Path $nodesDir $node.name
        Write-Progress -Activity 'Custom nodes' -Status $node.name -PercentComplete (($idx / $nodes.Count) * 100)

        if (Test-Path $target) {
            if (-not $Force) { Info ($node.name + ': already installed'); continue }
            Remove-Item $target -Recurse -Force
        }

        try {
            $zip = Join-Path $Cache ('nodes\' + $node.name + '.zip')
            Get-Download ('https://codeload.github.com/' + $node.repo + '/zip/' + $node.sha) $zip
            $tmp = Join-Path $Cache ('nodes\tmp-' + $node.name)
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-ZipSafe $zip $tmp
            $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
            Move-Item $inner.FullName $target
            Remove-Item $tmp -Recurse -Force
            Ok ($node.name + ' @ ' + $node.sha.Substring(0, 7))
        } catch {
            Fail ($node.name + ': ' + $_.Exception.Message)
        }
    }
    Write-Progress -Activity 'Custom nodes' -Completed

    $localNodes = Join-Path $Root 'custom nodes'
    if (Test-Path $localNodes) {
        foreach ($dir in Get-ChildItem $localNodes -Directory) {
            $dest = Join-Path $nodesDir $dir.Name
            Copy-Item $dir.FullName $dest -Recurse -Force
            Ok ('local node ' + $dir.Name)
        }
    } else {
        Warn 'folder "custom nodes" not found - studio internal nodes not installed'
    }
} else {
    Info 'skipped (-SkipComfy)'
}

# --------------------------------------- 7. configuration and model folders ---

if (-not $SkipComfy) {
    Step 7 8 'Configuration and model folders'

    $flag = Join-Path $comfyRoot '.no-auto-update'
    if (-not (Test-Path $flag)) { New-Item -ItemType Directory -Force -Path $flag | Out-Null }
    Ok 'ComfyUI auto-update locked (.no-auto-update)'

    $yaml = Join-Path $comfyApp 'extra_model_paths.yaml'
    if (-not (Test-Path $yaml)) {
        $yamlText = @(
            '# MiniMax Studio: extra model paths.',
            '# This file is overwritten by the studio when model settings change.',
            'minimax_studio_detectors:',
            '    ultralytics:',
            '        - "models/ultralytics"',
            ''
        ) -join "`r`n"
        Write-TextFileNoBom $yaml $yamlText
        Ok 'extra_model_paths.yaml created'
    } else {
        Ok 'extra_model_paths.yaml already exists'
    }

    $modelDirs = @(
        'diffusion_models', 'text_encoders', 'vae', 'vae_approx', 'latent_upscale_models',
        'loras', 'veda', 'ultralytics', 'llm', 'checkpoints', 'clip', 'clip_vision',
        'controlnet', 'embeddings', 'upscale_models', 'unet', 'style_models', 'audio_encoders',
        'gligen', 'hypernetworks', 'ipadapter', 'photomaker', 'sams', 'sam2', 'sam3',
        'insightface', 'facerestore_models', 'onnx', 'diffusers', 'model_patches',
        'configs', 't5', 'pulid', 'instantid', 't2i_adapter'
    )
    $modelsRoot = Join-Path $comfyApp 'models'
    foreach ($d in $modelDirs) {
        $p = Join-Path $modelsRoot $d
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
    }
    foreach ($d in @('input', 'output', 'temp')) {
        $p = Join-Path $comfyApp $d
        if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
    }
    Ok ('model folders created: ' + $modelDirs.Count)

    if (-not (Test-Path (Join-Path $Root 'upscale\bin'))) {
        Warn 'Upscale tab will not work: upscale\bin folder missing (proprietary NVIDIA DLSS runtime, not included in repository).'
    }
    if (-not (Test-Path (Join-Path $Root 'stt\models'))) {
        Warn 'Voice input will not work: stt\ folder missing (whisper engine is not included in repository).'
    }
}

# -------------------------------------------------------- 8. verification ---

if (-not $SkipComfy) {
    Step 8 8 'Installation verification'

    Info 'verifying torch import...'
    & $python -c "import torch, torchvision, torchaudio; print('      torch', torch.__version__, '| cuda:', torch.cuda.is_available())"
    if ($LASTEXITCODE -ne 0) { Fail 'torch cannot be imported' } else { Ok 'torch is working' }

    Info 'verifying key libraries...'
    & $python -c "import cv2, numpy, scipy, transformers, safetensors, comfy_kitchen; print('      cv2', cv2.__version__, '| numpy', numpy.__version__)"
    if ($LASTEXITCODE -ne 0) { Fail 'some libraries failed to import' } else { Ok 'key libraries are working' }

    Info 'verifying ComfyUI and all nodes import (smoke test, 1-3 minutes)...'
    $outLog = Join-Path $Cache 'smoke-out.log'
    $errLog = Join-Path $Cache 'smoke-err.log'
    if (Test-Path $outLog) { Remove-Item $outLog -Force }
    if (Test-Path $errLog) { Remove-Item $errLog -Force }
    $proc = $null
    try {
        $proc = Start-Process -FilePath $python -WorkingDirectory $comfyApp -PassThru -NoNewWindow `
            -ArgumentList @('-I', 'main.py', '--windows-standalone-build', '--cpu', '--disable-auto-launch', '--port', '8199') `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog

        $ready = $false
        for ($i = 0; $i -lt 90; $i++) {
            Start-Sleep -Seconds 2
            if ($proc.HasExited) { break }
            try {
                $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8199/system_stats' -UseBasicParsing -TimeoutSec 3
                if ($r.StatusCode -eq 200) { $ready = $true; break }
            } catch { }
        }

        if ($ready) {
            Ok 'ComfyUI starts, server responding'
        } else {
            Fail 'ComfyUI did not start within 180 seconds - check install.log'
            foreach ($l in Get-Tail $outLog 20) { Write-Log ('      ' + $l) }
            foreach ($l in Get-Tail $errLog 20) { Write-Log ('      ' + $l) }
        }

        $importErrors = @()
        if (Test-Path $outLog) {
            $importErrors = @(Get-Content $outLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'IMPORT FAILED|Cannot import|ModuleNotFoundError' })
        }
        if ($importErrors.Count -gt 0) {
            Warn ('nodes with import errors: ' + $importErrors.Count)
            foreach ($l in ($importErrors | Select-Object -First 10)) { Write-Log ('      ' + $l.Trim()) }
        } elseif ($ready) {
            Ok 'all custom nodes loaded without errors'
        }
    } catch {
        Warn ('smoke test failed: ' + $_.Exception.Message)
    } finally {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
        try {
            Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        } catch { }
    }
}

# ------------------------------------------------------------ cleanup ---

if (-not $KeepCache) {
    if (Test-Path $Cache) {
        Info 'removing temporary archives...'
        Remove-Item $Cache -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($script:Python -and (Test-Path $script:Python)) {
        Info 'clearing pip cache...'
        & $script:Python -m pip cache purge 2>$null | Out-Null
    }
}

# ------------------------------------------------------------ summary ---

Write-Log ''
Write-Log '  ============================================================'
if ($script:Failures.Count -eq 0) {
    Write-Log '   INSTALLATION COMPLETED' 'ok'
} else {
    Write-Log ('   INSTALLATION COMPLETED WITH ERRORS: ' + $script:Failures.Count) 'err'
    foreach ($f in $script:Failures) { Write-Log ('   - ' + $f) 'err' }
}
Write-Log '  ============================================================'

if ($script:Warnings.Count -gt 0) {
    Write-Log ''
    Write-Log '  Warnings:' 'warn'
    foreach ($w in $script:Warnings) { Write-Log ('   - ' + $w) 'warn' }
}

Write-Log ''
Write-Log '  Next steps:'
Write-Log '    1. Run start.bat'
Write-Log '    2. Open Settings -> Models and download required models'
Write-Log '       (they are large: diffusion ~23 GB, text encoder ~16 GB, etc.)'
Write-Log '    3. Once models are downloaded, you can start generating'
Write-Log ''
Write-Log ('  Full log: ' + $LogFile)
Write-Log ''

$exitCode = 0
if ($script:Failures.Count -gt 0) { $exitCode = 1 }

if (-not $NoPause) {
    Write-Host '  Press Enter to close window...' -ForegroundColor DarkGray
    try { [void](Read-Host) } catch { }
}

exit $exitCode
