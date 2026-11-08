#!/usr/bin/env python3
"""Send chat text or a held key to the game window.

    send-keys.py chat "#goto 100 64 200"   -> t, text, Enter (opens game chat)
    send-keys.py key w 600                  -> hold W for 600 ms

Linux uses python-xlib (pip install python-xlib; no tkinter needed) on $DISPLAY.
Windows and macOS use pyautogui (pip install pyautogui). The game window must be
focused. On a window manager-less Xvfb screen the pointer is moved to the centre so
the keys reach the game. Typing assumes a US keyboard layout.
"""
import sys
import time

KEYS = {"w": "w", "a": "a", "s": "s", "d": "d", "space": "space", "shift": "shift", "ctrl": "ctrl"}
XK_NAMES = {"space": "space", "shift": "Shift_L", "ctrl": "Control_L", "enter": "Return"}


def fail(message):
    sys.stderr.write(message + "\n")
    sys.exit(2)


class XlibBackend:
    def __init__(self):
        try:
            from Xlib import X, XK, display
            from Xlib.ext import xtest
        except ImportError as error:
            fail(f"python-xlib is not installed ({error}). Run: pip install python-xlib")
        try:
            self.display = display.Display()
        except Exception as error:  # noqa: BLE001
            fail(f"Cannot reach the screen ({error}). Check DISPLAY and that the game is running.")
        self.X, self.XK, self.xtest = X, XK, xtest
        self.shift = self.display.keysym_to_keycode(XK.string_to_keysym("Shift_L"))

    def centre_pointer(self):
        root = self.display.screen().root
        geometry = root.get_geometry()
        root.warp_pointer(geometry.width // 2, geometry.height // 2)
        self.display.sync()

    def _keysym(self, name):
        keysym = self.XK.string_to_keysym(XK_NAMES.get(name, name))
        if keysym == 0 and len(name) == 1:
            keysym = ord(name)
        return keysym

    def _fake(self, kind, keycode):
        self.xtest.fake_input(self.display, kind, keycode)
        self.display.sync()

    def _lookup(self, name):
        keysym = self._keysym(name)
        keycode = self.display.keysym_to_keycode(keysym)
        if not keycode:
            fail(f"No key for {name!r} on this keyboard layout")
        needs_shift = self.display.keycode_to_keysym(keycode, 0) != keysym
        return keycode, needs_shift

    def tap(self, name):
        keycode, needs_shift = self._lookup(name)
        if needs_shift:
            self._fake(self.X.KeyPress, self.shift)
        self._fake(self.X.KeyPress, keycode)
        self._fake(self.X.KeyRelease, keycode)
        if needs_shift:
            self._fake(self.X.KeyRelease, self.shift)

    def write(self, text, interval=0.015):
        for char in text:
            self.tap(char)
            time.sleep(interval)

    def hold(self, name, seconds):
        keycode, _ = self._lookup(name)
        self._fake(self.X.KeyPress, keycode)
        time.sleep(seconds)
        self._fake(self.X.KeyRelease, keycode)


class PyAutoGuiBackend:
    def __init__(self):
        try:
            import pyautogui
        except ImportError as error:
            fail(f"pyautogui is not installed ({error}). Run: pip install pyautogui")
        pyautogui.FAILSAFE = False
        pyautogui.PAUSE = 0.02
        self.p = pyautogui

    def centre_pointer(self):
        width, height = self.p.size()
        self.p.moveTo(width // 2, height // 2)

    def tap(self, name):
        self.p.press(XK_NAMES.get(name, name) if name != "enter" else "enter")

    def write(self, text, interval=0.015):
        self.p.write(text, interval=interval)

    def hold(self, name, seconds):
        self.p.keyDown(name)
        time.sleep(seconds)
        self.p.keyUp(name)


def backend():
    return XlibBackend() if sys.platform.startswith("linux") else PyAutoGuiBackend()


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "chat":
        text = sys.argv[2]
        b = backend()
        b.centre_pointer()
        b.tap("t")            # opens chat (ignored while a menu is open)
        time.sleep(0.35)
        b.write(text)
        time.sleep(0.1)
        b.tap("enter")
    elif len(sys.argv) >= 4 and sys.argv[1] == "key":
        name = sys.argv[2]
        if name not in KEYS:
            fail("key not allowed")
        b = backend()
        b.centre_pointer()
        b.hold(KEYS[name], max(50, min(int(sys.argv[3]), 3000)) / 1000.0)
    else:
        fail(__doc__)
    print("sent")


if __name__ == "__main__":
    main()
