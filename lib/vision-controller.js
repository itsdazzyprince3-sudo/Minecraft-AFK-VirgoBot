'use strict';

// Vision control loop. Two layers:
//   reflex   - fast (10-20 Hz) policy over the renderer's PERC summary: obstacle
//              distances, free-space corridor, visible entities. No model needed,
//              this is what "plays from the screen" in real time.
//   llm      - optional slow loop that sends the rendered frame to a local
//              vision model for higher-level decisions. Off unless enabled.
// The frame source is the C++ viewer (cpp/bot_view). Reflex reads the PERC
// stream from lib/frame-server; the LLM reads /frame.bmp from the viewer.

const zlib = require('node:zlib');

const ACTIONS = ['forward','back','left','right','turn_left','turn_right',
  'look_up','look_down','jump','mine','attack','use','stop','none','retreat'];

const PERCEPTION_STALE_MS = 800;

// ---- pure reflex policy (exported for tests) ----
// p: parsed PERC { haveWorld, haveFrame, freeCenter, freeLeft, freeRight,
//                  groundPct, skyPct, forwardClear, nearest, targetKind,
//                  targetDist, receivedAt }
// ctx: { health, food }
function reflexAction(p, ctx = {}) {
  if (!p || !p.haveWorld || !p.haveFrame) return 'stop';
  if (p.receivedAt && Date.now() - p.receivedAt > PERCEPTION_STALE_MS) return 'stop';
  const health = Number.isFinite(ctx.health) ? ctx.health : 20;
  const clear = Number(p.forwardClear) || 0;

  // Hostile in reach: hit it. Do this before movement so it does not walk into
  // the mob while trying to path around it.
  if (p.targetKind === 1 && p.targetDist > 0 && p.targetDist <= 5) return 'attack';
  // Low health with a hostile nearby: back off instead of trading hits.
  if (health <= 7 && p.targetKind === 1 && p.targetDist <= 8) return 'retreat';

  // No floor ahead / looking into the void: stand still rather than walk off.
  // The sky platform at spawn is exactly this case.
  if (p.groundPct < 12 && p.nearest >= 40 && p.skyPct > 40) return 'none';

  // Something directly ahead: steer to the side with more open space.
  if (clear < 1.2) {
    if (p.freeLeft >= p.freeRight && p.freeLeft >= p.freeCenter) return 'turn_left';
    if (p.freeRight > p.freeLeft) return 'turn_right';
    return 'jump';
  }
  // Look mostly at the sky with no floor: do not commit to a heading.
  if (p.groundPct < 8) return 'none';

  if (clear > 2.2) return 'forward';
  if (p.freeCenter >= 40) return 'forward';
  return p.freeLeft >= p.freeRight ? 'turn_left' : 'turn_right';
}

// ---- pure-Node PNG encoder (8-bit RGBA, no deps) ----
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function pngFromRGBA(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rowLen = w * 4;
  const raw = Buffer.alloc((rowLen + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (rowLen + 1)] = 0; rgba.copy(raw, y * (rowLen + 1) + 1, y * rowLen, y * rowLen + rowLen); }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---- BMP (24-bit) decoder ----
function bmpToRGBA(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const dataOff = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  let h = buf.readInt32LE(22);
  const topDown = h < 0; if (topDown) h = -h;
  const bpp = buf.readUInt16LE(28);
  if (bpp !== 24) return null;
  const rowSize = ((w * 3 + 3) & ~3);
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = topDown ? y : (h - 1 - y);
    const rowBase = dataOff + srcRow * rowSize;
    for (let x = 0; x < w; x++) {
      const b = buf[rowBase + x * 3], g = buf[rowBase + x * 3 + 1], r = buf[rowBase + x * 3 + 2];
      const o = (y * w + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return { w, h, rgba };
}

class VisionController {
  constructor(opts = {}) {
    this.getBot = opts.getBot || (() => null);
    this.isConnected = opts.isConnected || (() => true);
    this.getPerception = opts.getPerception || null;
    this.viewerUrl = (opts.viewerUrl || 'http://127.0.0.1:8080').replace(/\/$/, '');
    this.ollamaUrl = (opts.ollamaUrl || 'http://127.0.0.1:11434/api/chat').replace(/\/$/, '');
    this.model = opts.model || 'llava';
    this.intervalMs = Number(opts.intervalMs) || 4000;
    this.reflexHz = Math.max(1, Math.min(30, Number(opts.reflexHz) || 10));
    this.reflex = opts.reflex !== false;
    this.llm = opts.llm !== false;
    this.dryRun = !!opts.dryRun;
    this.enabled = !!opts.enabled;
    this.onLog = opts.onLog || (() => {});
    this.timerReflex = null;
    this.timerLLM = null;
    this.lastAction = 'none';
    this.lastReflex = 'none';
    this.ticks = 0;
    this.reflexTicks = 0;
    this.failures = 0;
    this.paused = false;
    this.jumpUntil = 0;
    this.lastTurnAt = 0;
    this.lastAttackAt = 0;
    this.lastSummaryAt = 0;
    this.held = new Set();
  }

  start() {
    this.paused = false;
    this.failures = 0;
    if (this.timerReflex || this.timerLLM || !this.enabled) return;
    const reflexWanted = this.reflex && typeof this.getPerception === 'function';
    if (reflexWanted) {
      this.timerReflex = setInterval(() => this.reflexTick(), Math.round(1000 / this.reflexHz));
      if (this.timerReflex.unref) this.timerReflex.unref();
      const bot = this.getBot();
      if (bot) bot.aiScreenControl = true;
    }
    if (this.llm) {
      this.timerLLM = setInterval(() => this.tick().catch(e => this.onLog(`vision error: ${e.message}`)), this.intervalMs);
      if (this.timerLLM.unref) this.timerLLM.unref();
    }
    if (reflexWanted || this.llm) {
      const parts = [];
      if (reflexWanted) parts.push(`reflex ${this.reflexHz}Hz`);
      if (this.llm) parts.push(`llm every ${Math.round(this.intervalMs / 1000)}s${this.dryRun ? ' dry-run' : ` (${this.model})`}`);
      this.onLog(`vision ON: ${parts.join(' + ')}`);
    } else {
      this.onLog('vision enabled but nothing to run (no PERC feed and llm disabled)');
    }
  }

  stop() {
    if (this.timerReflex) { clearInterval(this.timerReflex); this.timerReflex = null; }
    if (this.timerLLM) { clearInterval(this.timerLLM); this.timerLLM = null; }
    this.releaseControls();
    const bot = this.getBot();
    if (bot) bot.aiScreenControl = false;
    this.onLog('vision OFF');
  }

  status() {
    const p = this.getPerception ? this.getPerception() : null;
    return {
      enabled: Boolean(this.timerReflex || this.timerLLM),
      reflex: Boolean(this.timerReflex),
      llm: Boolean(this.timerLLM),
      model: this.model,
      ticks: this.ticks,
      reflexTicks: this.reflexTicks,
      lastAction: this.lastAction,
      perceptionAgeMs: p && p.receivedAt ? Date.now() - p.receivedAt : null,
      dryRun: this.dryRun
    };
  }

  // ---- reflex layer ----
  reflexTick() {
    if (!this.enabled || this.paused || !this.isConnected()) return;
    const bot = this.getBot();
    if (!bot?.entity) return;
    bot.aiScreenControl = true;
    if (bot.aiManualControl) { this.releaseControls(); return; }
    let p = null;
    try { p = this.getPerception ? this.getPerception() : null; } catch { p = null; }
    const action = reflexAction(p, { health: bot.health, food: bot.food });
    this.reflexTicks += 1;
    this.lastAction = action;
    this.lastReflex = action;
    this.applyReflex(bot, action);
    const now = Date.now();
    if (now - this.lastSummaryAt >= 10000 && p) {
      this.lastSummaryAt = now;
      this.onLog(`reflex ${action} | clear=${p.forwardClear.toFixed(1)} free=${p.freeCenter}/${p.freeLeft}/${p.freeRight} ` +
        `ground=${p.groundPct} sky=${p.skyPct} target=${p.targetKind}@${p.targetDist}`);
    }
  }

  releaseControls() {
    const bot = this.getBot();
    if (!bot) return;
    for (const key of this.held) { try { bot.setControlState?.(key, false); } catch { /* ignore */ } }
    this.held.clear();
    this.jumpUntil = 0;
  }

  hold(bot, key, on) {
    try {
      if (on) { bot.setControlState?.(key, true); this.held.add(key); }
      else if (this.held.has(key)) { bot.setControlState?.(key, false); this.held.delete(key); }
    } catch { /* ignore */ }
  }

  applyReflex(bot, action) {
    if (action !== 'forward' && action !== 'back' && action !== 'left' && action !== 'right' && action !== 'retreat') {
      for (const key of ['forward', 'back', 'left', 'right']) this.hold(bot, key, false);
    }
    switch (action) {
      case 'forward': this.hold(bot, 'forward', true); break;
      case 'back': this.hold(bot, 'back', true); break;
      case 'left': this.hold(bot, 'left', true); break;
      case 'right': this.hold(bot, 'right', true); break;
      case 'retreat': this.hold(bot, 'back', true); break;
      case 'jump': {
        const now = Date.now();
        if (now >= this.jumpUntil) {
          this.hold(bot, 'jump', true);
          this.jumpUntil = now + 260;
          setTimeout(() => this.hold(bot, 'jump', false), 180).unref?.();
        }
        break;
      }
      case 'turn_left':
      case 'turn_right': {
        const now = Date.now();
        if (now - this.lastTurnAt >= 220) {
          this.lastTurnAt = now;
          const delta = action === 'turn_left' ? -0.3 : 0.3;
          try { bot.look(bot.entity.yaw + delta, bot.entity.pitch); } catch { /* ignore */ }
        }
        break;
      }
      case 'attack': {
        const now = Date.now();
        if (now - this.lastAttackAt >= 650) { this.lastAttackAt = now; this.attackNearest(bot); }
        break;
      }
      case 'none':
      case 'stop':
      default:
        break;
    }
  }

  // ---- optional LLM layer ----
  async captureFrame() {
    const res = await fetch(`${this.viewerUrl}/frame.bmp`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`viewer /frame.bmp HTTP ${res.status}`);
    const bmp = Buffer.from(await res.arrayBuffer());
    const decoded = bmpToRGBA(bmp);
    if (!decoded) throw new Error('could not decode viewer frame (expected 24-bit BMP)');
    return decoded;
  }

  botState() {
    const bot = this.getBot();
    if (!bot || !bot.entity) return '';
    const entities = Object.values(bot.entities || {})
      .filter(e => e && e !== bot.entity && e.position)
      .slice(0, 6)
      .map(e => `${e.name || e.username || e.type}@${Math.round(e.position.x)},${Math.round(e.position.y)},${Math.round(e.position.z)}`)
      .join('; ');
    return `health ${bot.health}/20, food ${bot.food}/20, holding ${bot.heldItem?.name || 'nothing'}, nearby: ${entities || 'none'}`;
  }

  async askModel(pngBase64, stateText) {
    if (this.dryRun) {
      const choice = ['forward', 'turn_left', 'none', 'look_down'][this.ticks % 4];
      return `ACTION: ${choice} - (dry-run simulated)`;
    }
    const system = 'You control a Minecraft bot by watching its first-person view. The image is a software-raycasted view: blocks are colored cubes with face shading; entities are colored squares (RED=mob/hostile, GREEN=player, YELLOW=other). Keep the bot alive and gather resources. Reply with exactly one line: "ACTION: <action> - <reason>". Valid actions: ' + ACTIONS.join(' ') + '. Pick one.';
    const user = `State: ${stateText}. What should I do next?`;
    const body = {
      model: this.model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user, images: [pngBase64] }
      ],
      options: { temperature: 0.2, num_ctx: 2048 }
    };
    const res = await fetch(this.ollamaUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    return String(data?.message?.content || data?.response || '').trim();
  }

  parseAction(text) {
    const m = String(text || '').match(/ACTION:\s*([a-z_]+)/i);
    let action = m ? m[1].toLowerCase() : '';
    if (!ACTIONS.includes(action)) {
      for (const candidate of ACTIONS) if (String(text).toLowerCase().includes(candidate)) { action = candidate; break; }
    }
    return ACTIONS.includes(action) ? action : 'none';
  }

  async tick() {
    if (this.paused || !this.isConnected()) return;
    try {
      const frame = await this.captureFrame();
      const png = pngFromRGBA(frame.rgba, frame.w, frame.h);
      const b64 = png.toString('base64');
      const reply = await this.askModel(b64, this.botState());
      const action = this.parseAction(reply);
      this.lastAction = action;
      this.ticks += 1;
      this.failures = 0;
      this.applyAction(action);
      this.onLog(`llm tick #${this.ticks}: ${action} | ${String(reply).split('\n')[0].slice(0, 120)}`);
    } catch (e) {
      this.failures += 1;
      if (this.failures === 1 || this.failures % 5 === 0) {
        this.onLog(`error #${this.failures}: ${e.message}`);
      }
      if (this.failures >= 3 && !this.paused) {
        this.paused = true;
        this.onLog(`llm paused after ${this.failures} failures (last: ${e.message}). Is Ollama + a vision model running? Is the C++ viewer up?`);
      }
    }
  }

  clearControls() {
    const bot = this.getBot();
    if (!bot || !bot.entity) return;
    try { for (const k of ['forward','back','left','right','jump','sprint']) bot.setControlState?.(k, false); } catch { /* ignore */ }
  }

  applyAction(action) {
    const bot = this.getBot();
    if (!bot || !bot.entity) return;
    this.clearControls();
    try {
      switch (action) {
        case 'forward': bot.setControlState?.('forward', true); break;
        case 'back': bot.setControlState?.('back', true); break;
        case 'left': bot.setControlState?.('left', true); break;
        case 'right': bot.setControlState?.('right', true); break;
        case 'retreat': bot.setControlState?.('back', true); break;
        case 'jump': bot.setControlState?.('jump', true); break;
        case 'turn_left': bot.look?.(bot.entity.yaw - 0.35, bot.entity.pitch); break;
        case 'turn_right': bot.look?.(bot.entity.yaw + 0.35, bot.entity.pitch); break;
        case 'look_up': bot.look?.(bot.entity.yaw, bot.entity.pitch - 0.3); break;
        case 'look_down': bot.look?.(bot.entity.yaw, bot.entity.pitch + 0.3); break;
        case 'mine': this.digForward(bot); break;
        case 'attack': this.attackNearest(bot); break;
        case 'use': bot.activateItem?.(); break;
        case 'stop': break;
        case 'none': default: break;
      }
    } catch (e) { this.onLog(`vision apply error: ${e.message}`); }
  }

  digForward(bot) {
    if (!bot.blockAt || !bot.dig) return;
    const e = bot.entity.position;
    const fwd = { x: -Math.sin(bot.entity.yaw), y: 0, z: Math.cos(bot.entity.yaw) };
    const target = bot.blockAt({ x: Math.floor(e.x + fwd.x), y: Math.floor(e.y + 1.5), z: Math.floor(e.z + fwd.z) });
    if (target && target.name && target.name !== 'air') bot.dig(target).catch(() => {});
  }

  attackNearest(bot) {
    if (!bot.entities || !bot.attack) return;
    const e = bot.entity.position;
    let best = null, bestDistance = 4.5;
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.position || entity.type !== 'mob') continue;
      const distance = entity.position.distanceTo(e);
      if (distance < bestDistance) { bestDistance = distance; best = entity; }
    }
    if (best) bot.attack(best).catch(() => {});
  }
}

module.exports = { VisionController, reflexAction, pngFromRGBA, bmpToRGBA, ACTIONS };
