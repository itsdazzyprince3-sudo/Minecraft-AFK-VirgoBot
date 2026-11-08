'use strict';

// Streams the bot's first-person world to the local C++ raycaster (protocol v2).
// World snapshots are sent once (VWLD); block changes go as deltas (VBLK); pose
// and entities flow every tick (VFRM). The viewer answers with a compact
// perception summary (PERC) that the reflex layer consumes, so the bot's skills
// can act on what it actually sees.
//
// Framing: tag(4 ascii) + u32le payload length + payload.
//   VWLD: i32 ox,oy,oz; u16 W,H,D; u8 grid[W*H*D]  (idx = x + W*(z + D*y))
//   VBLK: u16 count; {i16 rx,ry,rz; u8 kind} x count
//   VFRM: f32 eyeX,eyeY,eyeZ; f32 yaw,pitch; u16 entCount;
//         {f32 rx,ry,rz; u8 kind; u8 nameLen; name} x entCount
//   PERC (viewer -> node): 28 bytes, see parsePerception().

const net = require('node:net');
const { EventEmitter } = require('node:events');

const DEFAULT_FRAME_PORT = Number(process.env.VIEW_FRAME_PORT) || 31337;
const DEFAULT_W = Number(process.env.VIEW_W) || 64;
const DEFAULT_H = Number(process.env.VIEW_H) || 48;
const DEFAULT_D = Number(process.env.VIEW_D) || 64;
const DEFAULT_TICK_HZ = Number(process.env.VIEW_TICK_HZ) || 20;
const DEFAULT_RESYNC_MS = 60000;
const MAX_PENDING = 8192;
const MAX_ENTITIES = 48;
const MAX_ENT_NAME = 31;

// block.name -> uint8 render kind (0 = air/transparent, renderer skips it)
function blockKind(name) {
  if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') return 0;
  if (name === 'water') return 7;
  if (name === 'lava') return 9;
  if (/glass$/.test(name)) return 11;
  if (name === 'snow' || name === 'snow_block' || /ice$/.test(name)) return 10;
  if (name === 'grass_block' || name === 'grass' || name === 'moss_block') return 3;
  if (/_log$/.test(name)) return 4;
  if (/leaves$/.test(name) || name === 'azalea' || name === 'mangrove_roots') return 5;
  if (/sand$/.test(name) || name === 'gravel' || name === 'red_sand') return 6;
  if (/_ore$/.test(name)) return 8;
  if (name === 'netherrack' || name === 'nether_bricks' || name === 'soul_sand' || name === 'soul_soil') return 13;
  if (name === 'bedrock' || name === 'obsidian' || name === 'crying_obsidian') return 14;
  if (/_sapling$/.test(name) || /_stem$/.test(name) || name === 'vine' || /flower$/.test(name) || name === 'tall_grass' || name === 'fern') return 12;
  if (name === 'dirt' || name === 'farmland' || name === 'podzol' || name === 'coarse_dirt' || name === 'rooted_dirt') return 2;
  if (name === 'stone' || name === 'cobblestone' || /deepslate$/.test(name) || /_bricks$/.test(name)) return 1;
  return 15;
}

function entityKind(entity) {
  if (entity?.type === 'player') return 2;
  if (entity?.type === 'mob') return 1;
  return 3;
}

function frameMessage(tag, payload) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function packWorld(origin, w, h, d, grid) {
  const head = Buffer.alloc(20);
  head.writeInt32LE(origin.x, 0);
  head.writeInt32LE(origin.y, 4);
  head.writeInt32LE(origin.z, 8);
  head.writeUInt16LE(w, 12);
  head.writeUInt16LE(h, 14);
  head.writeUInt16LE(d, 16);
  return frameMessage('VWLD', Buffer.concat([head, grid]));
}

function packDeltas(entries) {
  const body = Buffer.alloc(2 + entries.length * 7);
  body.writeUInt16LE(entries.length, 0);
  let off = 2;
  for (const e of entries) {
    body.writeInt16LE(e.rx, off);
    body.writeInt16LE(e.ry, off + 2);
    body.writeInt16LE(e.rz, off + 4);
    body.writeUInt8(e.kind, off + 6);
    off += 7;
  }
  return frameMessage('VBLK', body);
}

function packPose(eye, yaw, pitch, entities) {
  const head = Buffer.alloc(22);
  head.writeFloatLE(eye.x, 0);
  head.writeFloatLE(eye.y, 4);
  head.writeFloatLE(eye.z, 8);
  head.writeFloatLE(Number(yaw) || 0, 12);
  head.writeFloatLE(Number(pitch) || 0, 16);
  head.writeUInt16LE(entities.length, 20);
  const pieces = [head];
  for (const e of entities) {
    const name = Buffer.from(String(e.name || '').slice(0, MAX_ENT_NAME), 'utf8');
    const entry = Buffer.alloc(14 + name.length);
    entry.writeFloatLE(e.rx, 0);
    entry.writeFloatLE(e.ry, 4);
    entry.writeFloatLE(e.rz, 8);
    entry.writeUInt8(e.kind, 12);
    entry.writeUInt8(name.length, 13);
    name.copy(entry, 14);
    pieces.push(entry);
  }
  return frameMessage('VFRM', Buffer.concat(pieces));
}

function parsePerception(payload) {
  if (payload.length < 28) return null;
  const seq = payload.readUInt32LE(0);
  const fps = payload.readUInt16LE(4);
  const flags = payload.readUInt8(6);
  const targetKind = payload.readUInt8(24);
  const targetSx = payload.readInt16LE(20);
  const targetSy = payload.readInt16LE(22);
  return {
    seq,
    fps,
    haveWorld: Boolean(flags & 1),
    haveFrame: Boolean(flags & 2),
    freeCenter: payload.readUInt8(7),
    freeLeft: payload.readUInt8(8),
    freeRight: payload.readUInt8(9),
    groundPct: payload.readUInt8(10),
    skyPct: payload.readUInt8(11),
    forwardClear: payload.readFloatLE(12),
    nearest: payload.readFloatLE(16),
    targetSx,
    targetSy,
    targetKind: targetKind === 0 && targetSx < 0 ? 0 : (targetKind || 3),
    targetDist: payload.readUInt8(25),
    receivedAt: Date.now()
  };
}

class FrameServer extends EventEmitter {
  constructor({ getBot, isConnected, port = DEFAULT_FRAME_PORT, w = DEFAULT_W, h = DEFAULT_H, d = DEFAULT_D,
    tickHz = DEFAULT_TICK_HZ, resyncMs = DEFAULT_RESYNC_MS } = {}) {
    super();
    this.getBot = getBot || (() => null);
    this.isConnected = isConnected || (() => true);
    this.port = port;
    this.w = Math.max(8, Math.min(512, Number(w) || DEFAULT_W));
    this.h = Math.max(8, Math.min(512, Number(h) || DEFAULT_H));
    this.d = Math.max(8, Math.min(512, Number(d) || DEFAULT_D));
    this.tickHz = Math.max(1, Math.min(60, Number(tickHz) || DEFAULT_TICK_HZ));
    this.resyncMs = Math.max(1000, Number(resyncMs) || DEFAULT_RESYNC_MS);
    this.server = null;
    this.clients = new Set();
    this.timer = null;
    this.botRef = null;
    this.onBlockUpdate = this.handleBlockUpdate.bind(this);
    this.onSpawn = () => { this.dirtyWorld = true; };
    this.world = null; // { origin:{x,y,z}, grid:Buffer }
    this.pending = new Map();
    this.dirtyWorld = true;
    this.lastWorldAt = 0;
    this.lastPerception = null;
    this.stats = { worldsSent: 0, deltaBatches: 0, deltaBlocks: 0, posesSent: 0, perceptions: 0 };
    this._readBuffers = new WeakMap();
  }

  start() {
    if (this.server) return;
    this.server = net.createServer((socket) => this.handleClient(socket));
    this.server.on('error', (e) => console.error(`[View] frame server error: ${e.message}`));
    this.server.listen(this.port, '127.0.0.1', () => {
      const addr = this.server.address();
      this.port = typeof addr === 'object' && addr ? addr.port : this.port;
      console.log(`[View] frame server on 127.0.0.1:${this.port} (${this.w}x${this.h}x${this.d} @ ${this.tickHz}Hz)`);
      this.emit('listening', this.port);
    });
    this.timer = setInterval(() => this.tick(), Math.round(1000 / this.tickHz));
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.unbindBot();
    for (const sock of this.clients) { try { sock.destroy(); } catch { /* closed */ } }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch { /* closed */ } this.server = null; }
  }

  handleClient(socket) {
    socket.setNoDelay(true);
    this.clients.add(socket);
    this._readBuffers.set(socket, Buffer.alloc(0));
    socket.on('error', () => {});
    socket.on('close', () => { this.clients.delete(socket); this._readBuffers.delete(socket); });
    socket.on('data', (chunk) => this.handleData(socket, chunk));
    this.bindBot();
    if (!this.world || this.dirtyWorld) this.refreshWorld();
    if (this.world) try { socket.write(this.buildWorldMessage()); } catch { /* dropped */ }
    this.sendPose(socket);
  }

  handleData(socket, chunk) {
    let buffered = this._readBuffers.get(socket) || Buffer.alloc(0);
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 8) {
      const tag = buffered.toString('ascii', 0, 4);
      const len = buffered.readUInt32LE(4);
      if (len > 1024 * 1024) { this._readBuffers.set(socket, Buffer.alloc(0)); return; }
      if (buffered.length < 8 + len) break;
      const payload = buffered.subarray(8, 8 + len);
      buffered = buffered.subarray(8 + len);
      if (tag === 'PERC') {
        const perception = parsePerception(payload);
        if (perception) {
          this.lastPerception = perception;
          this.stats.perceptions += 1;
          this.emit('perception', perception);
        }
      }
    }
    this._readBuffers.set(socket, buffered);
  }

  bindBot() {
    const bot = this.getBot();
    if (!bot || bot === this.botRef) return;
    this.unbindBot();
    this.botRef = bot;
    this.dirtyWorld = true;
    this.world = null;
    if (typeof bot.on === 'function') {
      bot.on('blockUpdate', this.onBlockUpdate);
      bot.once('spawn', this.onSpawn);
    }
  }

  unbindBot() {
    const bot = this.botRef;
    if (!bot) return;
    try { bot.removeListener('blockUpdate', this.onBlockUpdate); } catch { /* ignore */ }
    try { bot.removeListener('spawn', this.onSpawn); } catch { /* ignore */ }
    this.botRef = null;
  }

  handleBlockUpdate(oldBlock, newBlock) {
    const block = newBlock || oldBlock;
    const position = block?.position;
    if (!position || !this.world) { this.dirtyWorld = true; return; }
    const o = this.world.origin;
    const rx = position.x - o.x;
    const ry = position.y - o.y;
    const rz = position.z - o.z;
    if (rx < 0 || ry < 0 || rz < 0 || rx >= this.w || ry >= this.h || rz >= this.d) return;
    if (this.pending.size >= MAX_PENDING) { this.dirtyWorld = true; this.pending.clear(); return; }
    this.pending.set((ry * this.d + rz) * this.w + rx, {
      rx, ry, rz, kind: blockKind(block.name)
    });
  }

  refreshWorld() {
    const bot = this.getBot();
    const entity = bot?.entity;
    if (!entity?.position) return false;
    const position = entity.position;
    const origin = {
      x: Math.floor(position.x) - (this.w >> 1),
      y: Math.floor(position.y + 1.62) - (this.h >> 1),
      z: Math.floor(position.z) - (this.d >> 1)
    };
    const grid = Buffer.alloc(this.w * this.h * this.d);
    let idx = 0;
    for (let y = 0; y < this.h; y++) {
      for (let z = 0; z < this.d; z++) {
        for (let x = 0; x < this.w; x++) {
          let kind = 0;
          try {
            const block = bot.blockAt
              ? bot.blockAt({ x: origin.x + x, y: origin.y + y, z: origin.z + z })
              : null;
            if (block?.name) kind = blockKind(block.name);
          } catch { /* unloaded -> air */ }
          grid[idx++] = kind;
        }
      }
    }
    this.world = { origin, grid };
    let nonAir = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i]) { nonAir++; if (nonAir > 64) break; }
    this.worldNonAir = nonAir;
    this.pending.clear();
    this.dirtyWorld = false;
    this.lastWorldAt = Date.now();
    return true;
  }

  buildWorldMessage() {
    const world = this.world;
    return packWorld(world.origin, this.w, this.h, this.d, world.grid);
  }

  collectEntities(bot, eyePosition) {
    const entities = [];
    let list = [];
    try { list = Object.values(bot.entities || {}); } catch { list = []; }
    const maxRange = Math.max(this.w, this.d);
    for (const entity of list) {
      if (!entity || entity === bot.entity || !entity.position) continue;
      const rx = entity.position.x - eyePosition.x;
      const ry = entity.position.y - eyePosition.y;
      const rz = entity.position.z - eyePosition.z;
      if (Math.hypot(rx, ry, rz) > maxRange) continue;
      entities.push({
        rx, ry, rz,
        kind: entityKind(entity),
        name: entity.username || entity.name || entity.type || 'entity'
      });
      if (entities.length >= MAX_ENTITIES) break;
    }
    return entities;
  }

  buildPoseMessage() {
    const bot = this.getBot();
    const entity = bot?.entity;
    if (!entity?.position) return null;
    const position = entity.position;
    const eyePosition = { x: position.x, y: position.y + 1.62, z: position.z };
    return packPose(eyePosition, entity.yaw, entity.pitch, this.collectEntities(bot, eyePosition));
  }

  sendPose(socket) {
    const message = this.buildPoseMessage();
    if (!message) return;
    try { socket.write(message); this.stats.posesSent += 1; } catch { this.clients.delete(socket); }
  }

  tick() {
    if (!this.clients.size) return;
    if (!this.isConnected()) return;
    this.bindBot();
    const bot = this.getBot();
    if (!bot?.entity?.position) return;
    const position = bot.entity.position;
    const origin = this.world?.origin;
    const drifted = !origin ||
      Math.abs(Math.floor(position.x) - (origin.x + (this.w >> 1))) > this.w / 4 ||
      Math.abs(Math.floor(position.z) - (origin.z + (this.d >> 1))) > this.d / 4 ||
      Math.abs(Math.floor(position.y + 1.62) - (origin.y + (this.h >> 1))) > this.h / 4;
    const emptyRetry = this.worldNonAir === 0 && Date.now() - this.lastWorldAt > 1000;
    if (this.dirtyWorld || !this.world || drifted || emptyRetry || Date.now() - this.lastWorldAt > this.resyncMs) {
      if (this.refreshWorld()) {
        const message = this.buildWorldMessage();
        for (const socket of this.clients) {
          try { socket.write(message); this.stats.worldsSent += 1; } catch { this.clients.delete(socket); }
        }
      } else {
        return;
      }
    } else if (this.pending.size) {
      const entries = Array.from(this.pending.values());
      this.pending.clear();
      for (const entry of entries) {
        if (this.world) {
          this.world.grid[entry.ry * this.d * this.w + entry.rz * this.w + entry.rx] = entry.kind;
        }
      }
      const message = packDeltas(entries);
      for (const socket of this.clients) {
        try { socket.write(message); this.stats.deltaBatches += 1; this.stats.deltaBlocks += entries.length; }
        catch { this.clients.delete(socket); }
      }
    }
    const pose = this.buildPoseMessage();
    if (pose) {
      for (const socket of this.clients) {
        try { socket.write(pose); this.stats.posesSent += 1; } catch { this.clients.delete(socket); }
      }
    }
  }
}

module.exports = { FrameServer, blockKind, parsePerception, frameMessage, packWorld, packDeltas, packPose };
