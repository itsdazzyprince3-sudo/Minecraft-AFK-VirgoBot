'use strict';

const { spawn } = require('node:child_process');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function parseWindowId(value) {
  const text = String(value || '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error(`Invalid X11 window id: ${text || '(empty)'}`);
  return text;
}

function splitJpegFrames(buffer, maxBytes = MAX_FRAME_BYTES) {
  const frames = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start < 0) return { frames, remainder: buffer.subarray(Math.max(0, buffer.length - 1)) };
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) {
      if (buffer.length - start > maxBytes) return { frames, remainder: Buffer.alloc(0) };
      return { frames, remainder: buffer.subarray(start) };
    }
    const frameEnd = end + 2;
    if (frameEnd - start <= maxBytes) frames.push(buffer.subarray(start, frameEnd));
    cursor = frameEnd;
  }
  return { frames, remainder: Buffer.alloc(0) };
}

class LinuxScreenCapture {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.display = options.display || process.env.DISPLAY || '';
    this.pinnedWindowId = options.windowId || process.env.MINECRAFT_WINDOW_ID || '';
    this.windowId = this.pinnedWindowId;
    this.windowTitle = options.windowTitle || 'Minecraft';
    this.fps = Math.max(1, Math.min(15, Number(options.fps) || 5));
    this.maxWidth = Math.max(320, Math.min(1920, Number(options.maxWidth) || 1280));
    this.spawnImpl = options.spawn || spawn;
    this.execFileSync = options.execFileSync || execFileSync;
    this.execFile = options.execFileAsync || execFileAsync;
    this.onLog = options.onLog || (() => {});
    this.child = null;
    this.latestFrame = null;
    this.capturedAt = 0;
    this.buffer = Buffer.alloc(0);
    this.error = null;
    this.stopping = false;
    this.restartTimer = null;
    this.controlEnabled = options.controlEnabled === true;
    this.controlDurationMs = Math.max(150, Math.min(2000, Number(options.controlDurationMs) || 650));
    this.turnPixels = Math.max(20, Math.min(500, Number(options.turnPixels) || 130));
    this.keyTimers = new Map();
  }

  resolveWindowId() {
    if (this.pinnedWindowId) return parseWindowId(this.pinnedWindowId);
    if (!this.windowTitle) throw new Error('Set screenCapture.windowTitle or MINECRAFT_WINDOW_ID.');
    let output;
    try {
      output = this.execFileSync('xdotool', ['search', '--onlyvisible', '--name', this.windowTitle], {
        encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      throw new Error(`Could not find a visible Minecraft window matching "${this.windowTitle}". Install xdotool or set MINECRAFT_WINDOW_ID.`);
    }
    const ids = String(output).trim().split(/\s+/).filter(Boolean);
    if (!ids.length) throw new Error(`No visible X11 window matches "${this.windowTitle}".`);
    return parseWindowId(ids[ids.length - 1]);
  }

  ffmpegArgs(windowId) {
    return [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(this.fps),
      '-window_id', windowId, '-i', this.display,
      '-vf', `scale=w='min(${this.maxWidth},iw)':h=-2`,
      '-an', '-c:v', 'mjpeg', '-q:v', '7', '-f', 'mjpeg', 'pipe:1'
    ];
  }

  start() {
    if (this.platform !== 'linux') throw new Error('Real window capture currently supports Linux X11 only.');
    if (!this.display) throw new Error('No X11 DISPLAY is available. Start the bot from the logged-in Linux desktop session.');
    if (this.child) return;
    this.stopping = false;
    this.error = null;
    let windowId;
    try {
      windowId = this.resolveWindowId();
      this.child = this.spawnImpl('ffmpeg', this.ffmpegArgs(windowId), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.error = error.message;
      this.onLog(`capture could not start: ${error.message}`);
      throw error;
    }
    this.windowId = windowId;
    this.buffer = Buffer.alloc(0);
    this.child.stdout.on('data', chunk => this.handleData(chunk));
    this.child.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) this.error = text.slice(0, 500);
    });
    this.child.on('error', error => {
      this.error = error.message;
      this.onLog(`ffmpeg error: ${error.message}`);
    });
    this.child.on('close', code => {
      this.child = null;
      if (this.stopping) return;
      this.error = this.error || `ffmpeg exited with code ${code}`;
      if (!this.pinnedWindowId) this.windowId = '';
      this.onLog(`${this.error}; retrying in 3 seconds`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        try { this.start(); } catch { /* start logs the actionable error */ }
      }, 3000);
      this.restartTimer.unref?.();
    });
    this.onLog(`capturing real Minecraft window ${windowId} on ${this.display} at ${this.fps} fps`);
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_FRAME_BYTES * 2) {
      const lastStart = this.buffer.lastIndexOf(Buffer.from([0xff, 0xd8]));
      this.buffer = lastStart >= 0 ? this.buffer.subarray(lastStart) : Buffer.alloc(0);
    }
    const parsed = splitJpegFrames(this.buffer);
    this.buffer = Buffer.from(parsed.remainder);
    for (const frame of parsed.frames) {
      this.latestFrame = Buffer.from(frame);
      this.capturedAt = Date.now();
    }
  }

  getFrame() {
    if (!this.latestFrame || Date.now() - this.capturedAt > 5000) {
      throw new Error(this.error || 'No recent Minecraft-window frame is available. Check ffmpeg, xdotool, DISPLAY, and the window title.');
    }
    return this.latestFrame;
  }

  status() {
    return {
      enabled: Boolean(this.child),
      ready: Boolean(this.latestFrame && Date.now() - this.capturedAt <= 5000),
      windowId: this.windowId || null,
      frameAgeMs: this.capturedAt ? Date.now() - this.capturedAt : null,
      error: this.error
    };
  }

  async xdotool(...args) {
    await this.execFile('xdotool', args, { timeout: 5000, windowsHide: true });
  }

  async focusWindow() {
    if (!this.windowId) throw new Error('Minecraft window is not selected yet.');
    try {
      await this.xdotool('windowactivate', '--sync', this.windowId);
    } catch {
      await this.xdotool('windowfocus', '--sync', this.windowId);
    }
  }

  async keyPulse(key, durationMs = this.controlDurationMs) {
    await this.focusWindow();
    await this.xdotool('keydown', key);
    const previous = this.keyTimers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.keyTimers.delete(key);
      void this.xdotool('keyup', key).catch(() => {});
    }, durationMs);
    timer.unref?.();
    this.keyTimers.set(key, timer);
  }

  async releaseAll() {
    for (const timer of this.keyTimers.values()) clearTimeout(timer);
    this.keyTimers.clear();
    await this.focusWindow().catch(() => {});
    await this.xdotool('keyup', 'w', 'a', 's', 'd', 'space', 'shift', 'ctrl').catch(() => {});
    await this.xdotool('mouseup', '1').catch(() => {});
    await this.xdotool('mouseup', '3').catch(() => {});
  }

  async performAction(action) {
    if (!this.controlEnabled) throw new Error('Desktop input is disabled; set screenCapture.controlWindow=true to allow game controls.');
    await this.focusWindow();
    const movementKeys = { forward: 'w', back: 's', left: 'a', right: 'd', retreat: 's' };
    if (movementKeys[action]) return this.keyPulse(movementKeys[action]);
    switch (action) {
      case 'stop': return this.releaseAll();
      case 'jump': return this.keyPulse('space', 140);
      case 'turn_left': return this.xdotool('mousemove_relative', '--', String(-this.turnPixels), '0');
      case 'turn_right': return this.xdotool('mousemove_relative', '--', String(this.turnPixels), '0');
      case 'look_up': return this.xdotool('mousemove_relative', '--', '0', String(-Math.round(this.turnPixels / 2)));
      case 'look_down': return this.xdotool('mousemove_relative', '--', '0', String(Math.round(this.turnPixels / 2)));
      case 'attack': return this.xdotool('click', '1');
      case 'use': return this.xdotool('click', '3');
      case 'mine':
        await this.xdotool('mousedown', '1');
        {
          const previous = this.keyTimers.get('mouse1');
          if (previous) clearTimeout(previous);
          const timer = setTimeout(() => {
            this.keyTimers.delete('mouse1');
            void this.xdotool('mouseup', '1').catch(() => {});
          }, 350);
          timer.unref?.();
          this.keyTimers.set('mouse1', timer);
          return undefined;
        }
      case 'none': return undefined;
      default: throw new Error(`Unsupported desktop action: ${action}`);
    }
  }

  stop() {
    if (this.controlEnabled) void this.releaseAll().catch(() => {});
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    for (const timer of this.keyTimers.values()) clearTimeout(timer);
    this.keyTimers.clear();
    try { this.child?.kill('SIGTERM'); } catch { /* already stopped */ }
    this.child = null;
    this.latestFrame = null;
    this.buffer = Buffer.alloc(0);
  }
}

module.exports = { LinuxScreenCapture, parseWindowId, splitJpegFrames };
