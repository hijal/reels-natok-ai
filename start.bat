@echo off
REM (fix 587) chcp 65001 REMOVED: cmd.exe under code page 65001
REM improperly tracks read positions in batch files with multibyte UTF-8
REM characters (Cyrillic in comments) — after an 8KB block
REM the parser stumbled in the middle of words, executed comment fragments
REM as commands and silently skipped launch commands.
REM Comments are kept in plain ASCII — without 65001 the parser handles
REM bytes correctly; echo strings are translated to ASCII.
setlocal EnableExtensions

title MiniMax H3 Studio - Web
cd /d "%~dp0"

set PORT=3000
set COMFY_PORT=8188
REM Priority: [comfy] comfy_dir -> COMFY_ROOT from environment -> bundled path.
set "COMFY_ROOT_CONFIG="
if exist config\config.ini (
    for /f "tokens=1,* delims==" %%a in ('findstr /i /b /c:"comfy_dir" config\config.ini 2^>nul') do if not defined COMFY_ROOT_CONFIG set "COMFY_ROOT_CONFIG=%%b"
)
if defined COMFY_ROOT_CONFIG set "COMFY_ROOT_CONFIG=%COMFY_ROOT_CONFIG:"=%"
if defined COMFY_ROOT_CONFIG set "COMFY_ROOT=%COMFY_ROOT_CONFIG%"
if not defined COMFY_ROOT set "COMFY_ROOT=ComfyUI-Easy-Install"

echo.
echo  ============================================
echo    MiniMax H3 Studio
echo  ============================================
echo.

REM ============================================================
REM  [CHECK 1/5] Node.js — bundled runtime\node.exe first, then PATH
REM ============================================================
set "NODE_CMD="
if exist "%~dp0runtime\node.exe" (
    set "NODE_CMD=%~dp0runtime\node.exe"
    echo  [OK] Using bundled runtime\node.exe
)
if not defined NODE_CMD (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE_CMD=node"
        echo  [OK] Node.js found in PATH
    )
)
if not defined NODE_CMD (
    echo.
    echo  [ERROR] Node.js not found: neither runtime\node.exe nor in PATH.
    echo          Copy node.exe into the runtime\ folder next to start.bat.
    echo.
    call :pause_or_log "[ERROR] Node.js not found: runtime\node.exe and PATH missing"
    exit /b 1
)
for /f "tokens=*" %%v in ('"%NODE_CMD%" --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER%

REM ============================================================
REM  [CHECK 2/5] ComfyUI folder
REM ============================================================
REM (fix 551) Check via goto rather than ( ... ) block: set /p and reading
REM %CONTINUE% inside ONE block do not work — variable was expanded
REM during block PARSING (before input), was always empty, and :web_ui
REM label did not exist at all. Fallback "frontend only"
REM was broken — if ComfyUI folder was missing script simply exited.
if exist "%COMFY_ROOT%\python_embeded\python.exe" goto comfy_ok
echo.
echo  [WARN] ComfyUI not found at: %COMFY_ROOT%
echo         Expected folder: %~dp0%COMFY_ROOT%\python_embeded\python.exe
echo         Place the ComfyUI-Easy-Install folder next to this project.
echo.
set /p CONTINUE=         Start Web UI anyway, frontend only [Y/N]:
if /i "%CONTINUE%"=="Y" goto frontend_only
call :pause_or_log "[ERROR] ComfyUI not found, user declined frontend-only start"
exit /b 0
:frontend_only
REM (fix 551) Frontend-only: Start Web UI, but not ComfyUI backend.
set "FRONTEND_ONLY=1"
echo  [WARN] Frontend-only mode: generation will not work without ComfyUI.
goto comfy_check_done
:comfy_ok
echo  [OK] ComfyUI found: %COMFY_ROOT%
:comfy_check_done

REM ============================================================
REM  [CHECK 3/5] node_modules (auto-install; needs real npm)
REM ============================================================
if exist "node_modules" (
    echo  [OK] Dependencies present.
) else (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] node_modules not found and npm is unavailable.
        echo          Copy the project together with node_modules\ from the
        echo          source PC - same Windows x64 - or install full Node.js
        echo          18+ from https://nodejs.org first.
        echo.
        call :pause_or_log "[ERROR] node_modules not found and npm is unavailable"
        exit /b 1
    )
    echo  [INSTALL] node_modules not found - running npm install...
    call npm install
    if errorlevel 1 (
        echo  [ERROR] npm install failed.
        call :pause_or_log "[ERROR] npm install failed"
        exit /b 1
    )
    echo  [OK] Dependencies installed.
)

REM ============================================================
REM  [CHECK 4/5] Production build (auto-build; needs real npm)
REM ============================================================
if exist ".next\BUILD_ID" (
    echo  [OK] Build present.
) else (
    where npm >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  [ERROR] .next build not found and npm is unavailable.
        echo          Copy the project together with the .next\ folder from
        echo          the source PC, or install full Node.js 18+ first.
        echo.
        call :pause_or_log "[ERROR] .next build not found and npm is unavailable"
        exit /b 1
    )
    echo  [BUILD] .next build not found - running npm run build...
    call npm run build
    if errorlevel 1 (
        echo  [ERROR] Build failed.
        call :pause_or_log "[ERROR] npm run build failed"
        exit /b 1
    )
    echo  [OK] Production build complete.
)

REM ============================================================
REM  Start the browser studio before ComfyUI finishes loading.
REM  The sidebar displays the backend connection status.
REM ============================================================
echo.
echo  Starting web UI...

REM Kill any existing process on web port (LISTENING only — see above)
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /C:":%PORT% " ^| findstr /C:"LISTENING" 2^>nul') do (
    taskkill /F /PID %%p >nul 2>&1
)
%SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul

set NODE_ENV=production

REM Web server in background; logs remain in this console.
start /b "" "%NODE_CMD%" server.js

REM Wait for web server to respond (typically 1-3s)
echo       Starting web server...
set /a wt=0
:wait_web
set /a wt+=1
if %wt% gtr 30 (
    echo  [ERROR] Web server did not start within 60s.
    call :pause_or_log "[ERROR] Web server did not start within 60s"
    exit /b 1
)
powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/' -TimeoutSec 3 -UseBasicParsing); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto web_ready
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
goto wait_web

:web_ready
echo  [OK] Web UI is up.

echo.
echo  ============================================
echo    Web UI:   http://localhost:%PORT%
echo    ComfyUI:  http://127.0.0.1:%COMFY_PORT%
echo    Backend:  %COMFY_ROOT%
echo  ============================================
echo.
echo  Opening browser...
echo.

REM (fix 128) Open browser on top of all windows (not in background).
REM explorer.exe is simple, but Windows foreground-lock may prevent focus.
REM (fix 129b) Reliable approach — PowerShell + SetForegroundWindow.
call :open_browser_foreground http://localhost:%PORT%/

REM ============================================================
REM  Start ComfyUI backend
REM ============================================================
REM (fix 551) Frontend-only (no ComfyUI folder, user answered Y):
REM Do not start backend — jump directly to keepalive (Web UI already running,
REM the studio displays backend connection status).
if defined FRONTEND_ONLY (
    echo  [WARN] Frontend-only mode: ComfyUI backend NOT started.
    goto keepalive
)
echo.
echo  Starting ComfyUI backend...

REM Kill any existing process on ComfyUI port
REM IMPORTANT: two findstr /C: sequentially. Single findstr ":port .*LISTENING"
REM in literal mode splits pattern on spaces into OR-alternatives and
REM matches ANY line with ":port" (including ESTABLISHED browser and node connections)
REM — taskkill /F would terminate user's entire browser.
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /C:":%COMFY_PORT% " ^| findstr /C:"LISTENING" 2^>nul') do (
    taskkill /F /PID %%p >nul 2>&1
)
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul

REM Start ComfyUI in background (fix 140) — launch python.exe directly
REM (fix 551) Read settings from config\config.ini — FIRST parse
REM (variables are EMPTY), THEN set defaults. Previously defaults were set
REM BEFORE parsing, so the guard "if not defined" was always false and whatever
REM the user configured in "Settings" (reserve_gb, vram_headroom, async_offload)
REM was silently ignored — ComfyUI always started with hardcoded defaults.
REM Pattern and validation matches scripts\start_comfy.bat (fixes 357/490):
REM findstr /b /c: matches only lines STARTING with key (not comments),
REM first match wins, invalid values -> safe default.
set "RESERVE_VRAM="
set "DYNAMIC_VRAM="
set "ASYNC_OFFLOAD="
set "VRAM_HEADROOM="
if exist config\config.ini (
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"reserve_gb" config\config.ini 2^>nul') do if not defined RESERVE_VRAM set "RESERVE_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"dynamic_vram" config\config.ini 2^>nul') do if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=%%a"
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"async_offload" config\config.ini 2^>nul') do if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=%%a"
    REM (fix 521) vram_headroom — extra margin of free VRAM for DynamicVRAM
    for /f "tokens=2 delims==" %%a in ('findstr /i /b /c:"vram_headroom" config\config.ini 2^>nul') do if not defined VRAM_HEADROOM set "VRAM_HEADROOM=%%a"
)
if not defined RESERVE_VRAM set "RESERVE_VRAM=3"
if not defined DYNAMIC_VRAM set "DYNAMIC_VRAM=1"
if not defined ASYNC_OFFLOAD set "ASYNC_OFFLOAD=0"
if not defined VRAM_HEADROOM set "VRAM_HEADROOM=2"
set "RESERVE_VRAM=%RESERVE_VRAM:"=%"
set "DYNAMIC_VRAM=%DYNAMIC_VRAM:"=%"
set "ASYNC_OFFLOAD=%ASYNC_OFFLOAD:"=%"
set "VRAM_HEADROOM=%VRAM_HEADROOM:"=%"
echo %RESERVE_VRAM%| findstr /r "^[0-9][0-9.]*$" >nul || set "RESERVE_VRAM=3"
echo %DYNAMIC_VRAM%| findstr /r "^[01]$" >nul || set "DYNAMIC_VRAM=1"
echo %ASYNC_OFFLOAD%| findstr /r "^[01]$" >nul || set "ASYNC_OFFLOAD=0"
echo %VRAM_HEADROOM%| findstr /r "^[0-9][0-9.]*$" >nul || set "VRAM_HEADROOM=2"
set "EXTRA_FLAGS="
if not "%ASYNC_OFFLOAD%"=="1" set "EXTRA_FLAGS=--disable-async-offload --disable-pinned-memory"
REM (fix 521) --vram-headroom: DynamicVRAM (aimdo) continuously keeps
REM this many GB genuinely free (via NVML, including third-party apps).
REM 0 = flag not passed (legacy behavior).
set "HEADROOM_FLAG="
if not "%VRAM_HEADROOM%"=="0" set "HEADROOM_FLAG=--vram-headroom %VRAM_HEADROOM%"
REM (fix 551) dynamic_vram=0 -> --disable-dynamic-vram (as in start_comfy.bat;
REM previously this flag was never passed from start.bat).
set "DYN_FLAG="
if "%DYNAMIC_VRAM%"=="0" set "DYN_FLAG=--disable-dynamic-vram"

REM Launch ComfyUI directly
start /b "" "%COMFY_ROOT%\python_embeded\python.exe" -I "%COMFY_ROOT%\ComfyUI\main.py" --windows-standalone-build --use-ck-attention --disable-auto-launch --reserve-vram %RESERVE_VRAM% %DYN_FLAG% %EXTRA_FLAGS% %HEADROOM_FLAG%

REM Wait for ComfyUI to be ready (the studio also tracks connection status)
echo       Waiting for ComfyUI (first start can take 30-90s)...
set /a tries=0
:wait_comfy
set /a tries+=1
if %tries% gtr 120 (
    echo.
    echo  [WARN] ComfyUI did not start within 240s.
    echo  Check the output above and the ComfyUI connection indicator.
    echo.
    goto keepalive
)
powershell -NoProfile -Command "try { [void](Invoke-WebRequest -Uri 'http://127.0.0.1:%COMFY_PORT%/' -TimeoutSec 3 -UseBasicParsing); exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto comfy_ready
%SystemRoot%\System32\timeout.exe /t 2 /nobreak >nul
goto wait_comfy

:comfy_ready
echo  [OK] ComfyUI is ready. The browser studio can now generate videos.

REM ============================================================
REM  Keepalive: console retains background processes (web + ComfyUI).
REM  Closing window = stops everything (as before).
REM ============================================================
:keepalive
echo.
echo  To STOP: close this window.
echo.
:keepalive_loop
%SystemRoot%\System32\timeout.exe /t 30 /nobreak >nul
goto keepalive_loop

REM ============================================================
REM (fix 129b) Subroutine: open URL in browser ON TOP of all windows.
REM
REM Windows foreground-lock prevents scripts from directly seizing focus.
REM Working workaround: Start-Process launches the browser, then 500ms later
REM PowerShell via Win32 P/Invoke SetForegroundWindow forcibly brings
REM browser window to foreground (this works because call originates
REM from process launched via Start-Process — which has permission
REM for SetForegroundWindow).
REM ============================================================
:open_browser_foreground
setlocal
set "_URL=%~1"

REM 1) Open URL in default browser (Start-Process yields a new
REM    process which Windows permits SetForegroundWindow).
powershell -NoProfile -Command "Start-Process -FilePath '%_URL%'" >nul 2>&1

REM 2) After 500ms forcibly bring browser window to front.
REM    (If browser hasn't created window yet — SetForegroundWindow safely
REM    no-ops; if window exists — it takes focus.)
REM (fix 130) Removed `^` line continuations: cmd strips them, but PowerShell
REM    sees them as arguments -> Add-Type failed with "positional parameter '")".
REM    Now a single line without continuations.
%SystemRoot%\System32\timeout.exe /t 1 /nobreak >nul
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int n); [DllImport(\"user32.dll\")] public static extern bool IsZoomed(IntPtr hWnd); public static void BringToFront() { IntPtr fg = GetForegroundWindow(); if (fg != IntPtr.Zero) { if (!IsZoomed(fg)) { ShowWindow(fg, 3); } SetForegroundWindow(fg); } } }' ; [FG]::BringToFront()" >nul 2>&1

endlocal
goto :eof

REM ============================================================
REM Display launch errors in this visible console.
REM ============================================================
:pause_or_log
echo  %~1
pause
goto :eof
