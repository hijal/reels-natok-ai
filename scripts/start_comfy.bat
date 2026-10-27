@echo off
REM (fix 587) chcp 65001 REMOVED: under code page 65001 cmd.exe
REM incorrectly tracks file seek positions in batch files with UTF-8
REM characters — the parser could trip up and distort/skip the
REM ComfyUI launch line. Without 65001, the parser navigates bytes correctly.
setlocal EnableExtensions
cd /d "%~dp0.."

set "COMFY_ROOT=ComfyUI-Easy-Install"

REM Read VRAM config from config.ini (optional, defaults: reserve=3, dynamic=1)
REM First matching line wins — immune to stray duplicate keys from old configs.
set "RESERVE_VRAM="
set "DYNAMIC_VRAM="
set "ASYNC_OFFLOAD="
set "VRAM_HEADROOM="
if exist config\config.ini (
    REM (fix 357) /b /c:"key" — match only lines STARTING with the key:
    REM previously findstr also matched comments like "REM reserve_gb=99".
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"reserve_gb" config\config.ini 2^>nul') do if not defined RESERVE_VRAM set "RESERVE_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"dynamic_vram" config\config.ini 2^>nul') do if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"async_offload" config\config.ini 2^>nul') do if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=%%a"
    REM (fix 490) vram_headroom — additional free VRAM reserve for DynamicVRAM
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"vram_headroom" config\config.ini 2^>nul') do if not defined VRAM_HEADROOM set "VRAM_HEADROOM=%%a"
)
if not defined RESERVE_VRAM set "RESERVE_VRAM=3"
if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=1"
if not defined VRAM_HEADROOM set "VRAM_HEADROOM=2"
REM (fix) async_offload defaults to 0 (disabled). comfy-aimdo 0.4.13
REM on Windows+NVIDIA crashes when loading large models (~20 GB):
REM   hostbuf_file_reader_read failed / HostBuffer.read_file_slice failed,
REM   GetOverlappedResult error=1450/1453 (insufficient system resources).
REM Cause — async weight offloading (2 threads) + pinned memory. Disabling them
REM makes the model load synchronously and reliably. To re-enable (faster
REM loading, but may crash on RTX 50xx): async_offload=1 in config\config.ini.
if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=0"
set "RESERVE_VRAM=%RESERVE_VRAM:"=%"
set "DYNAMIC_VRAM=%DYNAMIC_VRAM:"=%"
set "ASYNC_OFFLOAD=%ASYNC_OFFLOAD:"=%"
set "VRAM_HEADROOM=%VRAM_HEADROOM:"=%"
REM (fix 357) Validation: value from config.ini is interpolated into launch
REM commands — garbage (spaces, text, units like "GB") would break the command line.
REM Non-numeric value → safe default.
echo %RESERVE_VRAM%| findstr /r "^[0-9][0-9.]*$" >nul || set "RESERVE_VRAM=3"
echo %DYNAMIC_VRAM%| findstr /r "^[01]$" >nul || set "DYNAMIC_VRAM=1"
echo %ASYNC_OFFLOAD%| findstr /r "^[01]$" >nul || set "ASYNC_OFFLOAD=0"
echo %VRAM_HEADROOM%| findstr /r "^[0-9][0-9.]*$" >nul || set "VRAM_HEADROOM=2"
set "EXTRA_FLAGS="
if not "%ASYNC_OFFLOAD%"=="1" set "EXTRA_FLAGS=--disable-async-offload --disable-pinned-memory"
REM (fix 490) --vram-headroom: DynamicVRAM (aimdo) continuously keeps
REM this many GB genuinely free (via NVML, including third-party apps) —
REM protection against activation spikes jumping over --reserve-vram.
REM 0 = flag omitted (legacy behavior).
set "HEADROOM_FLAG="
if not "%VRAM_HEADROOM%"=="0" set "HEADROOM_FLAG=--vram-headroom %VRAM_HEADROOM%"

REM ============================================================
REM  [CHECK] Block auto-update if .no-auto-update flag exists
REM ============================================================
REM (fix 132) ComfyUI-Easy-Install may auto-update
REM  and pull in a new version incompatible with the old structure.
REM  The .no-auto-update folder is a flag: if it exists, updates
REM  are blocked. This protects against unintended updates to an incompatible
REM  version.
if exist "%COMFY_ROOT%\.no-auto-update" (
    echo  [OK] Auto-update blocked (.no-auto-update flag present).
    echo       ComfyUI will NOT update itself.
) else (
    echo  [WARN] Auto-update NOT blocked.
    echo         ComfyUI-Easy-Install may update itself and break.
    echo         To block: mkdir ComfyUI-Easy-Install\.no-auto-update
)

REM ============================================================
REM  [CHECK] Verify ComfyUI version compatibility
REM ============================================================
REM (fix 131) ComfyUI-Easy-Install may auto-update
REM  and pull in a new version incompatible with the old structure
REM  (comfy.ldm was removed, but execution.py still imports it).
REM  Verify that comfy.ldm exists — otherwise ComfyUI will crash
REM  with ModuleNotFoundError.
if not exist "%COMFY_ROOT%\ComfyUI\comfy\ldm\models\autoencoder.py" (
    echo.
    echo  [ERROR] Incompatible ComfyUI version detected.
    echo          The 'comfy.ldm' module is missing, but execution.py
    echo          still imports it. This happens when ComfyUI-Easy-Install
    echo          auto-updates to a new version.
    echo.
    echo  Solution: revert to a stable version.
    echo    cd ComfyUI-Easy-Install\update
    echo    update_comfyui_stable.bat
    echo.
    pause
    exit /b 1
)
echo  [OK] ComfyUI version compatible.

REM Launch ComfyUI
if "%DYNAMIC_VRAM%"=="0" (
    "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% --disable-dynamic-vram %EXTRA_FLAGS% %HEADROOM_FLAG%
    exit /b %errorlevel%
) else (
    "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% %EXTRA_FLAGS% %HEADROOM_FLAG%
    exit /b %errorlevel%
)
