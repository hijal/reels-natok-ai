"""Launch the password-protected episode dashboard through Cloudflare Tunnel.

The dashboard uses short polling requests, including for planner logs, so it does
not require SSE support. Named tunnels use TUNNEL_TOKEN in the child environment;
the token is never put in command arguments, notebook output or saved settings.
"""
import os
import json
from pathlib import Path
import platform
import re
import secrets
import subprocess
import time
from urllib.parse import urlsplit
import urllib.request


def stop_process(process):
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def install_cloudflared(runtime):
    machine = platform.machine().lower()
    if platform.system() != "Linux" or machine not in {"x86_64", "amd64", "aarch64", "arm64"}:
        raise RuntimeError("This launcher targets Linux Colab runtimes")
    arch = "amd64" if machine in {"x86_64", "amd64"} else "arm64"
    binary = Path(runtime) / "cloudflared"
    if not binary.exists():
        url = f"https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-{arch}"
        temp = binary.with_suffix(".download")
        try:
            with urllib.request.urlopen(url, timeout=120) as response, temp.open("wb") as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
            if temp.stat().st_size < 1024 * 1024:
                raise RuntimeError("Incomplete cloudflared download")
            temp.chmod(0o700)
            temp.replace(binary)
        finally:
            temp.unlink(missing_ok=True)
    subprocess.run([str(binary), "--version"], check=True, capture_output=True)
    return binary


def tunnel_command(binary, port, token=""):
    # Supply a deliberately empty config so unrelated cloudflared configuration
    # cannot disable Quick Tunnels or change the origin.
    command = [str(binary), "tunnel", "--no-autoupdate", "--config", "/dev/null"]
    if token:
        return command + ["run"]
    return command + ["--url", f"http://127.0.0.1:{port}"]


def launch_dashboard(workspace, runtime, python, comfy_url, *, password="", token="", public_url="", port=7860):
    runtime = Path(runtime).resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    if token:
        parsed = urlsplit(public_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("Named tunnels need their configured HTTPS public hostname (no path or credentials)")
    password = password or secrets.token_urlsafe(18)
    if len(password) < 12:
        raise ValueError("Use a dashboard password of at least 12 characters")
    dashboard = tunnel = None
    boot_id = secrets.token_hex(24)
    env = {k: v for k, v in os.environ.items() if k not in {"TUNNEL_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN"}}
    env.update(REELS_WEB_PASSWORD=password, REELS_WEB_BOOT_ID=boot_id)
    server_log = runtime / "web-server.log"
    tunnel_log = runtime / "cloudflared.log"
    try:
        with server_log.open("wb") as log:
            dashboard = subprocess.Popen([str(python), "-u", str(Path(__file__).with_name("colab_web.py")),
                "--workspace", str(workspace), "--runtime", str(runtime), "--url", comfy_url, "--port", str(port)],
                stdout=log, stderr=subprocess.STDOUT, env=env)
        for _ in range(60):
            if dashboard.poll() is not None:
                raise RuntimeError("Dashboard failed to start. Inspect " + str(server_log))
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                    if response.status == 200 and json.loads(response.read()).get("boot_id") == boot_id:
                        break
            except OSError:
                pass
            time.sleep(.5)
        else:
            raise RuntimeError("Dashboard startup timed out. Inspect " + str(server_log))
        binary = install_cloudflared(runtime)
        tunnel_env = {k: v for k, v in os.environ.items() if k not in {"REELS_WEB_PASSWORD", "TUNNEL_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN"}}
        if token:
            tunnel_env["TUNNEL_TOKEN"] = token
        with tunnel_log.open("wb") as log:
            tunnel = subprocess.Popen(tunnel_command(binary, port, token), stdout=log,
                                      stderr=subprocess.STDOUT, env=tunnel_env)
        for _ in range(120):
            if tunnel.poll() is not None:
                raise RuntimeError("Tunnel exited. Inspect " + str(tunnel_log))
            output = tunnel_log.read_text(errors="replace")
            if token:
                if "Registered tunnel connection" in output:
                    break
            else:
                match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", output)
                if match:
                    public_url = match[0]
                    break
            time.sleep(.5)
        else:
            raise RuntimeError("Tunnel startup timed out. Inspect " + str(tunnel_log))
        print("Open your episode dashboard:", public_url, flush=True)
        print("Dashboard password:", password, flush=True)
        print("Keep this password private. Closing the browser does not stop a job.", flush=True)
        print("Named tunnel" if token else "Quick Tunnel: URL changes after a new tunnel session.", flush=True)
        print("Manage scripts, references, plans, tests, render, preview and download in the browser.", flush=True)
        return {"dashboard": dashboard, "tunnel": tunnel, "url": public_url}
    except BaseException:
        stop_process(tunnel)
        stop_process(dashboard)
        raise


def stop_dashboard(handles):
    stop_process(handles.get("tunnel"))
    stop_process(handles.get("dashboard"))


def watch_dashboard(handles, runtime, workspace):
    """Run inside the notebook so Drive/Colab APIs use their authenticated context."""
    from colab_finish import finish_run
    import json
    try:
        while handles["dashboard"].poll() is None and handles["tunnel"].poll() is None:
            request = Path(runtime) / "web-release.json"
            if request.exists():
                outputs = json.loads(request.read_text())["outputs"]
                # Stop serving files before Drive flush/unmount. Both the web
                # worker and finish_run have already checked the saved batch.
                stop_dashboard(handles)
                finish_run(outputs, workspace, len(outputs), auto_disconnect=True)
                return
            time.sleep(2)
        raise RuntimeError("Dashboard or tunnel stopped. Check web-server.log / cloudflared.log; rerun the launcher cell to reconnect.")
    finally:
        stop_dashboard(handles)
