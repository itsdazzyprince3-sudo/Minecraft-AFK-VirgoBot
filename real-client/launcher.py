#!/usr/bin/env python3
"""Real Minecraft (Fabric + Baritone) you can watch and control from a browser.

    python3 real-client/launcher.py setup                      # install game + mods
    python3 real-client/launcher.py start --server 1.2.3.4 --port 25565 --name Virgo

`start` launches the real Java client with Baritone, then the browser screen server.
On Linux without a display (VPS, proot, Termux) it starts a virtual screen (Xvfb)
with software rendering. Open http://127.0.0.1:3008/?token=YOUR_TOKEN afterwards.

Offline accounts only work on offline-mode servers. For online-mode servers add
--auth to sign in with a Microsoft account that owns Minecraft.
"""
import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DIR = Path(os.environ.get("MC_REAL_DIR", Path.home() / ".virgo-real-client"))
DEFAULT_VERSION = "1.21.4"
# Baritone release per Minecraft version (from the Baritone README download table).
BARITONE = {
    "1.21.4": "https://github.com/cabaletta/baritone/releases/download/v1.13.1/baritone-api-fabric-1.13.1.jar",
}
UA = {"User-Agent": "virgo-real-client/1.0 (minecraft-afk-virgobot)"}


def log(message):
    print(f"[real-client] {message}", flush=True)


def fetch(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=60) as response, open(dest, "wb") as out:
        shutil.copyfileobj(response, out)


def portablemc_cmd():
    found = shutil.which("portablemc")
    if found:
        return [found]
    return [sys.executable, "-m", "portablemc"]


def have(tool):
    return shutil.which(tool) is not None


def pip_install(*packages):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "--upgrade", *packages])


def fabric_api_url(version):
    query = urllib.parse.urlencode({"game_versions": json.dumps([version]), "loaders": json.dumps(["fabric"])})
    request = urllib.request.Request(f"https://api.modrinth.com/v2/project/fabric-api/version?{query}", headers=UA)
    with urllib.request.urlopen(request, timeout=30) as response:
        versions = json.load(response)
    if not versions:
        raise RuntimeError(f"No Fabric API build found for Minecraft {version}")
    files = versions[0]["files"]
    primary = next((f for f in files if f.get("primary")), files[0])
    return primary["url"], primary["filename"]


def cmd_setup(args):
    version = args.version
    mc_dir = Path(args.dir)
    mods = mc_dir / "mods"
    problems = []
    if sys.version_info < (3, 8):
        problems.append("Python 3.8+ is required.")
    if not have("ffmpeg"):
        problems.append("ffmpeg is missing (needed for the browser screen). Install it with your package manager.")
    if not have("node"):
        problems.append("Node.js 18+ is missing (runs the browser screen server).")
    if platform.system() == "Linux" and not os.environ.get("DISPLAY") and not have("Xvfb"):
        problems.append("No display found and Xvfb is missing. Debian/Ubuntu: sudo apt install xvfb libgl1-mesa-dri")
    for problem in problems:
        log("PROBLEM: " + problem)
    log("Installing launcher + keyboard helper (portablemc + a key sender)...")
    pip_install("portablemc", "python-xlib" if platform.system() == "Linux" else "pyautogui")

    baritone_url = args.baritone_url or BARITONE.get(version)
    if not baritone_url:
        known = ", ".join(sorted(BARITONE))
        raise SystemExit(f"No Baritone jar known for {version} (known: {known}). Pass --baritone-url with the Fabric jar "
                         "from https://github.com/cabaletta/baritone/releases")
    log(f"Downloading Baritone for {version}...")
    fetch(baritone_url, mods / Path(urllib.parse.urlparse(baritone_url).path).name)
    log("Downloading Fabric API...")
    url, filename = fabric_api_url(version)
    fetch(url, mods / filename)

    log(f"Installing Minecraft {version} with Fabric (downloads about 500 MB the first time)...")
    subprocess.check_call(portablemc_cmd() + ["--main-dir", str(mc_dir), "start", "--dry", f"fabric:{version}"])
    log("Setup finished." + ("" if not problems else " Fix the PROBLEM lines above before starting."))


def start_virtual_display(width, height):
    if platform.system() != "Linux" or os.environ.get("DISPLAY"):
        return None
    if not have("Xvfb"):
        raise SystemExit("No display and Xvfb is missing. Install Xvfb (sudo apt install xvfb libgl1-mesa-dri).")
    display = ":99"
    proc = subprocess.Popen(["Xvfb", display, "-screen", "0", f"{width}x{height}x24", "-nolisten", "tcp"])
    os.environ["DISPLAY"] = display
    (Path.home() / ".Xauthority").touch(exist_ok=True)  # python-xlib fails without this file
    os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")  # no GPU: use Mesa software rendering
    time.sleep(1.5)
    log(f"Started virtual screen {display} ({width}x{height}) with software rendering")
    return proc


def cmd_start(args):
    token = args.token or os.environ.get("SCREEN_TOKEN") or os.environ.get("DASHBOARD_TOKEN")
    if not token:
        raise SystemExit("Set a secret first: --token SECRET (or SCREEN_TOKEN). The screen is never served without one.")
    procs = []

    def cleanup(*_):
        for proc in reversed(procs):
            if proc.poll() is None:
                proc.terminate()
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    xvfb = start_virtual_display(args.width, args.height)
    if xvfb:
        procs.append(xvfb)

    if args.game_cmd:  # test hook: run any program instead of Minecraft
        game = subprocess.Popen(args.game_cmd, shell=True)
    else:
        mc_dir = str(args.dir)
        command = portablemc_cmd() + ["--main-dir", mc_dir, "start", f"fabric:{args.version}",
                                      "-u", args.name, "--join-server", args.server, "--join-server-port", str(args.port)]
        if args.auth:
            command.append("-a")
        log("Launching Minecraft: " + " ".join(command[-6:]))
        game = subprocess.Popen(command)
    procs.append(game)

    env = dict(os.environ, SCREEN_TOKEN=token, SCREEN_PORT=str(args.screen_port), SCREEN_HOST=args.screen_host)
    server = subprocess.Popen(["node", str(HERE / "screen-server.js")], env=env)
    procs.append(server)
    log(f"Open http://{args.screen_host}:{args.screen_port}/?token=<your token> in a browser")
    log("In game chat, Baritone commands start with #, for example: #goto 100 64 200, #mine diamond_ore, #stop")
    try:
        while game.poll() is None and server.poll() is None:
            time.sleep(1)
    finally:
        cleanup()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("setup", "start"):
        p = sub.add_parser(name)
        p.add_argument("--version", default=DEFAULT_VERSION, help="Minecraft version (default %(default)s)")
        p.add_argument("--dir", default=str(DEFAULT_DIR), help="where the game is installed (default %(default)s)")
    sub.choices["setup"].add_argument("--baritone-url", help="direct URL of the Baritone Fabric jar for this version")
    start = sub.choices["start"]
    start.add_argument("--server", required=True, help="server address, e.g. play.example.com")
    start.add_argument("--port", type=int, default=25565)
    start.add_argument("--name", default="VirgoBot", help="player name (offline-mode servers)")
    start.add_argument("--auth", action="store_true", help="sign in with a Microsoft account (online-mode servers)")
    start.add_argument("--token", help="secret for the browser page (or env SCREEN_TOKEN)")
    start.add_argument("--screen-port", type=int, default=3008)
    start.add_argument("--screen-host", default="127.0.0.1", help="use 0.0.0.0 only behind a trusted tunnel")
    start.add_argument("--width", type=int, default=1280)
    start.add_argument("--height", type=int, default=720)
    start.add_argument("--game-cmd", help=argparse.SUPPRESS)
    args = parser.parse_args()
    {"setup": cmd_setup, "start": cmd_start}[args.command](args)


if __name__ == "__main__":
    main()
