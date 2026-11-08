# Real Minecraft with Baritone, watched in your browser

This runs the **real Java Minecraft client** (Fabric + [Baritone](https://github.com/cabaletta/baritone))
and shows its exact screen in a web page. Baritone is the automation: you type
`#goto 100 64 200`, `#mine diamond_ore` or `#stop` and the real player walks, mines and
builds. The Mineflayer bot in the rest of this repo is separate and keeps working as before.

## What you get
- A browser page with the **live game screen** (ffmpeg capture, about 12 fps).
- A **command box** and buttons that type into the game chat (`t`, text, Enter), plus W/A/S/D/Jump.
- Everything starts from one terminal command. Nothing is served without your token.

## Requirements
- Python 3.8+, Node 18+, ffmpeg.
- A computer that can run Minecraft: Windows, macOS, or Linux (a PC or a VPS).
  Linux without a screen also needs `Xvfb` and Mesa: `sudo apt install xvfb libgl1-mesa-dri`.
- The server must be **offline-mode** (cracked/Aternos-style), or use `--auth` to sign in with a
  Microsoft account that owns Minecraft.

## Use
```bash
python3 real-client/launcher.py setup                      # installs the game, Fabric, Fabric API, Baritone
python3 real-client/launcher.py start --server play.example.com --port 25565 --name Virgo --token MYSECRET
```
Then open `http://127.0.0.1:3008/?token=MYSECRET`. On a VPS, tunnel the port
(`ssh -L 3008:127.0.0.1:3008 you@vps`) instead of exposing it.

Setup downloads about 500 MB the first time. The default is Minecraft **1.21.4**; for another
version pass `--version` and `--baritone-url` (the Fabric jar from the Baritone releases page,
which lists the right file for each Minecraft version).

## Limits, honestly
- **Termux/Android:** the real game needs a desktop Java environment. It can run inside
  `proot-distro` Debian with `Xvfb` and software rendering, but expect a few frames per second
  and heavy battery use. A PC or a cheap Linux VPS is the realistic choice. Windows works too.
- **Software rendering** (no GPU) makes Minecraft slow on a VPS. Lower the render distance in game.
- The command box types into the **focused** game window, so no menu or GUI can be open. If chat was
  left open, press Escape yourself first. Typing assumes a US keyboard layout.
- Baritone is a mod; many servers ban it. Use it where it is allowed.
- Verified in testing: the screen stream, the token protection, and keystroke delivery (against a
  stand-in window on a virtual screen). **Not verified:** the actual Minecraft/Fabric/Baritone download and
  launch, and Windows/macOS screen capture, because the test sandbox could not reach Mojang.

## Files
- `launcher.py`: setup and start (virtual screen on Linux, game, screen server).
- `screen-server.js`: the browser page, MJPEG stream and command endpoints.
- `send-keys.py`: sends keys to the game (python-xlib on Linux, pyautogui elsewhere).
