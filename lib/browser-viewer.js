'use strict';

// Optional live 3D view of what the bot sees, served as a small web page.
//
// This wraps prismarine-viewer's browser client but, unlike its built-in server, it
//  - binds to a chosen host (127.0.0.1 by default) instead of every interface,
//  - requires the dashboard token (query string once, then an HttpOnly cookie),
//  - keeps one server alive across bot reconnects.
//
// prismarine-viewer (and its native `canvas` dependency) are optional: if they are not
// installed, create() reports it and the bot keeps running without the viewer.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const COOKIE_NAME = 'viewer_token';
const CONTROL_INPUTS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']);
const CONTROL_ACTIONS = new Set([
  'attack', 'attack_release', 'use', 'use_release', 'slot', 'drop', 'drop_slot', 'swap_hand', 'equip', 'pick'
]);
const CAMERA_MAX_DISTANCE = 4;

// mineflayer yaw: 0 looks north (-Z), pi/2 west (-X), pi south (+Z), 3pi/2 east (+X).
// (View direction is (-sin yaw, ., -cos yaw); see mineflayer/lib/plugins/ray_trace.js.)
const FACING = [
  { name: 'north', axis: 'Towards negative Z' },
  { name: 'west', axis: 'Towards negative X' },
  { name: 'south', axis: 'Towards positive Z' },
  { name: 'east', axis: 'Towards positive X' }
];

function facingOf(yaw) {
  const turn = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return FACING[Math.round(turn / (Math.PI / 2)) % 4];
}

// The game's yaw in degrees as F3 shows it: 0 south, 90 west, 180/-180 north, -90 east.
function notchianYawDegrees(yaw) {
  const degrees = 180 - (yaw * 180) / Math.PI;
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

// How bright the sky is, 0 (night) to 1 (day), from the world time in ticks.
// 0-12000 day, dusk to 13800, night to 22200, dawn back to full day by 24000.
function skyBrightness(ticks) {
  if (!Number.isFinite(ticks)) return 1;
  const t = ((ticks % 24000) + 24000) % 24000;
  const smooth = x => x * x * (3 - 2 * x);
  if (t < 12000) return 1;
  if (t < 13800) return 1 - smooth((t - 12000) / 1800);
  if (t < 22200) return 0;
  return smooth((t - 22200) / 1800);
}

function secretsMatch(expected, provided) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

const WRAPPER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Bot view</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}
#wrap{position:absolute;inset:0;cursor:crosshair}
iframe,canvas,#eyes{position:absolute;inset:0;width:100%;height:100%;border:0}iframe{pointer-events:none}
#eyes{display:none;object-fit:contain;background:#000;image-rendering:pixelated;pointer-events:none}
canvas{pointer-events:none;image-rendering:pixelated}
#chat-box{display:none;position:absolute;left:8px;right:8px;bottom:8px}
#chat-input{width:100%;box-sizing:border-box;padding:6px 8px;background:rgba(0,0,0,.6);color:#fff;border:1px solid #888;font:16px monospace;outline:none}</style></head>
<body><div id="wrap"><iframe id="world" src="/" title="World"></iframe><img id="eyes" alt="What the bot sees"><canvas id="hud"></canvas>
<div id="chat-box"><input id="chat-input" maxlength="200" autocomplete="off" placeholder="Say something (Enter sends, Esc cancels)"></div></div>
<script src="/socket.io/socket.io.js"></script><script src="/hud.js"></script><script src="/camera.js"></script><script src="/controls.js"></script></body></html>`;

class BrowserViewer {
  constructor({ port = 3007, host = '127.0.0.1', token, viewDistance = 6, firstPerson = true, controls = null, eyesUrl = null, log = console.log } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.viewDistance = viewDistance;
    this.firstPerson = firstPerson;
    this.controls = controls;
    this.eyesUrl = eyesUrl;       // the C++ eye viewer (cpp/bot_view) to proxy behind the token
    this.log = log;
    this.bot = null;
    this.sockets = new Set();
    this.controlSockets = new Map();   // control socket -> { pov }
    this.selfBody = 0;                 // clients that want the bot's own body drawn (third person)
    this.lightSeen = false;
    this.chat = [];
    this.viewerPackage = null;
    this.onChat = message => {
      this.chat.push({ t: Date.now(), text: String(message).slice(0, 120) });
      if (this.chat.length > 20) this.chat.shift();
    };
    this.onMove = () => this.broadcastPose();
    this.server = null;
    this.io = null;
    this.WorldView = null;
  }

  isAuthorized(cookieHeader, queryToken) {
    return secretsMatch(this.token, queryToken) || secretsMatch(this.token, readCookie(cookieHeader, COOKIE_NAME));
  }

  start() {
    if (!this.token) {
      this.log('[Viewer] Not started: set DASHBOARD_TOKEN to protect the 3D view.');
      return false;
    }
    let viewerPackage;
    let express;
    let compression;
    let socketIo;
    try {
      this.WorldView = require('prismarine-viewer/viewer').WorldView;
      viewerPackage = path.dirname(require.resolve('prismarine-viewer/package.json'));
      this.viewerPackage = viewerPackage;
      express = require('express');
      // Resolve from prismarine-viewer so we use the copies it was installed with.
      compression = require(require.resolve('compression', { paths: [viewerPackage] }));
      socketIo = require(require.resolve('socket.io', { paths: [viewerPackage] }));
    } catch (error) {
      this.log(`[Viewer] Not started: optional dependency missing (${error.message.split('\n')[0]}). Run "npm install prismarine-viewer canvas".`);
      return false;
    }

    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
      const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
      if (!this.isAuthorized(req.headers.cookie, queryToken)) {
        return res.status(401).type('text').send('Dashboard token required. Open the dashboard and use the 3D view button.');
      }
      if (secretsMatch(this.token, queryToken)) {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Strict`);
      }
      next();
    });
    // The bot's real eyes (your C++ viewer), behind the same token. Fixed paths only, never a
    // user-supplied URL. Mounted before compression so the MJPEG stream is not buffered.
    const EYES_PATHS = { '/eyes/stream': '/stream', '/eyes/frame': '/frame', '/eyes/state': '/state' };
    app.get(Object.keys(EYES_PATHS), (req, res) => this.proxyEyes(req, res, EYES_PATHS[req.path]));
    app.use(compression());
    app.get('/watch', (req, res) => res.type('html').send(WRAPPER_PAGE));
    const script = file => (req, res) => res.type('js').set('Cache-Control', 'no-store').send(fs.readFileSync(path.join(__dirname, file)));
    app.get('/hud.js', script('viewer-hud.js'));
    app.get('/camera.js', script('viewer-camera.js'));
    app.get('/controls.js', script('viewer-controls.js'));
    app.get('/hook.js', script('viewer-hook.js'));
    app.get('/api/hud', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(this.hudState({ debug: req.query.debug === '1', inventory: req.query.inv === '1' }));
    });
    // The viewer page itself, with the render hook loaded ahead of its bundle.
    const viewerIndex = fs.readFileSync(path.join(viewerPackage, 'public', 'index.html'), 'utf8');
    const bundleTag = '<script type="text/javascript" src="index.js"></script>';
    const hooked = viewerIndex.includes(bundleTag);
    if (!hooked) this.log('[Viewer] Could not add the render hook (viewer page changed); third person and lighting are off.');
    const viewerPage = hooked ? viewerIndex.replace(bundleTag, `<script src="hook.js"></script>\n    ${bundleTag}`) : viewerIndex;
    app.get(['/', '/index.html'], (req, res) => res.type('html').set('Cache-Control', 'no-store').send(viewerPage));
    app.use('/', express.static(path.join(viewerPackage, 'public')));

    this.server = http.createServer(app);
    this.io = socketIo(this.server, { path: '/socket.io' });
    this.io.use((socket, next) => {
      if (this.isAuthorized(socket.handshake.headers.cookie, '')) return next();
      return next(new Error('unauthorized'));
    });
    this.io.on('connection', socket => this.handleConnection(socket));
    this.setupControlChannel();

    this.server.on('error', error => this.log(`[Viewer] Server error: ${error.message}`));
    this.server.listen(this.port, this.host, () => {
      this.log(`[Viewer] 3D view on http://${this.host}:${this.server.address().port}/ (token required)`);
    });
    return true;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.lightSeen = false;
    bot.on('messagestr', this.onChat);
    bot.on('move', this.onMove);
  }

  detach() {
    for (const socket of this.sockets) socket.disconnect(true);
    this.sockets.clear();
    if (this.bot) {
      this.bot.removeListener('messagestr', this.onChat);
      this.bot.removeListener('move', this.onMove);
    }
    this.bot = null;
  }

  // How far a third-person camera can sit behind (or in front of) the head before it would
  // end up inside a wall, like the game's own camera.
  cameraClearance(direction) {
    const bot = this.bot;
    const { Vec3 } = require('vec3');
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
    let hit = null;
    try { hit = bot.world.raycast(eye, new Vec3(direction[0], direction[1], direction[2]), CAMERA_MAX_DISTANCE); } catch { /* chunk not loaded */ }
    if (!hit || !hit.intersect) return CAMERA_MAX_DISTANCE;
    return Math.max(0.3, Math.min(CAMERA_MAX_DISTANCE, eye.distanceTo(hit.intersect) - 0.25));
  }

  // Sent every physics tick to control clients: the camera needs the real head direction and
  // (only while a third-person view is active) how much room there is behind or in front of it.
  broadcastPose() {
    const bot = this.bot;
    if (!bot || !bot.entity || this.controlSockets.size === 0) return;
    const yaw = bot.entity.yaw || 0;
    const pitch = bot.entity.pitch || 0;
    const pose = { yaw, pitch };
    if (this.selfBody > 0) {
      const dir = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
      pose.back = this.cameraClearance([-dir[0], -dir[1], -dir[2]]);
      pose.front = this.cameraClearance(dir);
    }
    this.io.of('/control').emit('pose', pose);
  }

  // Third person needs the bot's own body in the scene; the viewer never draws it by itself.
  setSelfBody(count) {
    this.selfBody = count;
    for (const socket of this.sockets) if (socket.sendSelf) socket.sendSelf();
  }

  // Keyboard/mouse control from the browser. Reuses the bot's manual-control session, which
  // pauses patrol/AI while keys are held and releases them if the browser goes away.
  setupControlChannel() {
    const channel = this.io.of('/control');
    channel.use((socket, next) => {
      if (this.controls && this.isAuthorized(socket.handshake.headers.cookie, '')) return next();
      return next(new Error('unauthorized'));
    });
    channel.on('connection', socket => {
      const controls = this.controls;
      this.controlSockets.set(socket, { pov: 0 });
      let budget = 200;
      const refill = setInterval(() => { budget = 200; }, 1000);
      const guard = handler => async (...args) => {
        if (budget-- <= 0) return;
        const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        try {
          if (!this.bot) throw new Error('The bot is not connected yet.');
          if (controls.busy()) throw new Error('Stop the active AI task before taking control.');
          const result = await handler(...args);
          if (ack) ack({ ok: true, result });
        } catch (error) {
          if (ack) ack({ ok: false, error: error.message });
          else socket.emit('denied', error.message);
        }
      };
      socket.on('input', guard((payload = {}) => {
        if (!CONTROL_INPUTS.has(payload.input) || typeof payload.pressed !== 'boolean') throw new TypeError('Bad input.');
        return controls.input(payload.input, payload.pressed);
      }));
      socket.on('action', guard((payload = {}) => {
        if (!CONTROL_ACTIONS.has(payload.action)) throw new TypeError('Bad action.');
        const slot = Number(payload.slot);
        if (payload.action === 'slot') return controls.action('slot', { slot: Number.isInteger(slot) ? slot : 0 });
        if (payload.action === 'equip' || payload.action === 'drop_slot') {
          if (!Number.isInteger(slot) || slot < 0 || slot > 45) throw new TypeError('Bad inventory slot.');
          return controls.action(payload.action, { slot, all: payload.all === true });
        }
        return controls.action(payload.action, {});
      }));
      socket.on('look', guard((payload = {}) => {
        const yaw = Number(payload.yaw);
        const pitch = Number(payload.pitch);
        if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new TypeError('Bad look.');
        return controls.look(yaw, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)));
      }));
      socket.on('chat', guard(text => {
        const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
        if (!clean) throw new TypeError('Empty message.');
        return controls.chat(clean);
      }));
      socket.on('heartbeat', guard(() => controls.heartbeat()));
      socket.on('ping-check', ack => { if (typeof ack === 'function') ack(Date.now()); });
      // Camera mode is only a view setting, so it does not need the AI to be idle.
      socket.on('pov', mode => {
        if (!Number.isInteger(mode) || mode < 0 || mode > 2) return;
        this.controlSockets.set(socket, { pov: mode });
        this.setSelfBody([...this.controlSockets.values()].filter(entry => entry.pov !== 0).length);
        this.broadcastPose();
      });
      socket.on('disconnect', () => {
        clearInterval(refill);
        this.controlSockets.delete(socket);
        this.setSelfBody([...this.controlSockets.values()].filter(entry => entry.pov !== 0).length);
        try { controls.release(); } catch { /* bot already gone */ }
      });
    });
  }

  proxyEyes(req, res, upstreamPath) {
    if (!this.eyesUrl) return res.status(404).type('text').send('The bot eye viewer is not enabled (set view.enabled).');
    const upstream = http.get(new URL(upstreamPath, this.eyesUrl), reply => {
      res.writeHead(reply.statusCode || 502, {
        'Content-Type': reply.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      reply.pipe(res);
    });
    upstream.setTimeout(5000, () => upstream.destroy());
    upstream.on('error', () => {
      if (res.headersSent) res.end();
      else res.status(502).type('text').send('The bot eye viewer is not running. Build it with cpp/README.md.');
    });
    res.on('close', () => upstream.destroy());
  }

  textureVersion(version) {
    const root = this.viewerPackage && path.join(this.viewerPackage, 'public', 'textures');
    if (root && version && fs.existsSync(path.join(root, version, 'gui', 'sprites', 'hud', 'hotbar.png'))) return version;
    return '1.21.4'; // HUD sprites are the same across 1.21.x
  }

  // Light at the bot's eye from the chunk light data the server sent. `known` stays false until
  // some non-zero light has been seen, so a server that sends no light data does not make the
  // view pitch black.
  lightInfo(skyFactor) {
    const bot = this.bot;
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0).floored();
    let block = null;
    try { block = bot.blockAt(eye); } catch { /* chunk not loaded */ }
    const blockLight = block && Number.isFinite(block.light) ? block.light : 0;
    const skyLight = block && Number.isFinite(block.skyLight) ? block.skyLight : 0;
    if (blockLight > 0 || skyLight > 0) this.lightSeen = true;
    return {
      known: this.lightSeen,
      block: blockLight,
      sky: skyLight,
      eff: Math.max(blockLight, Math.round(skyLight * skyFactor)),
      biome: block && block.biome && block.biome.name ? block.biome.name : null
    };
  }

  // The F3 screen. Only built while the browser has it open (the targeting rays cost a little).
  debugState(position, light) {
    const bot = this.bot;
    const floor = position.floored();
    const mod = n => ((n % 16) + 16) % 16;
    let target = null;
    try {
      const block = bot.blockAtCursor ? bot.blockAtCursor(6) : null;
      if (block) {
        const properties = typeof block.getProperties === 'function' ? block.getProperties() : {};
        target = { name: block.name, pos: [block.position.x, block.position.y, block.position.z], face: block.face, properties };
      }
    } catch { /* ignore */ }
    let targetEntity = null;
    try {
      const entity = bot.entityAtCursor ? bot.entityAtCursor(6) : null;
      if (entity) targetEntity = { name: entity.username || entity.name || 'entity', distance: Number(entity.position.distanceTo(position).toFixed(1)) };
    } catch { /* ignore */ }
    let chunks = null;
    try { chunks = bot.world.getColumns().length; } catch { /* world has no column list */ }
    const velocity = bot.entity.velocity || { x: 0, y: 0, z: 0 };
    const memory = process.memoryUsage();
    const perception = bot.aiPerception || null;
    return {
      version: bot.version,
      brand: 'Mineflayer',
      blockPos: [floor.x, floor.y, floor.z],
      inChunk: [mod(floor.x), mod(floor.y), mod(floor.z)],
      chunk: [Math.floor(floor.x / 16), Math.floor(floor.y / 16), Math.floor(floor.z / 16)],
      yawDegrees: Number(notchianYawDegrees(bot.entity.yaw || 0).toFixed(1)),
      pitchDegrees: Number((-(bot.entity.pitch || 0) * 180 / Math.PI).toFixed(1)),
      facingAxis: facingOf(bot.entity.yaw || 0).axis,
      biome: light.biome,
      chunksLoaded: chunks,
      entities: Object.keys(bot.entities || {}).length,
      ping: bot.player && Number.isFinite(bot.player.ping) ? bot.player.ping : null,
      velocity: [velocity.x, velocity.y, velocity.z],
      onGround: Boolean(bot.entity.onGround),
      saturation: bot.foodSaturation ?? null,
      air: bot.oxygenLevel ?? null,
      raining: Boolean(bot.isRaining),
      day: bot.time && Number.isFinite(bot.time.day) ? bot.time.day : null,
      target,
      targetEntity,
      node: process.version,
      memoryMb: { heap: Math.round(memory.heapUsed / 1048576), rss: Math.round(memory.rss / 1048576) },
      eyes: Boolean(this.eyesUrl),
      perception: perception ? {
        fps: perception.fps,
        freeCenter: perception.freeCenter,
        freeLeft: perception.freeLeft,
        freeRight: perception.freeRight,
        forwardClear: perception.forwardClear,
        nearest: perception.nearest,
        ageMs: perception.receivedAt ? Date.now() - perception.receivedAt : null
      } : null
    };
  }

  inventoryState() {
    const slots = [];
    const source = this.bot.inventory && this.bot.inventory.slots ? this.bot.inventory.slots : [];
    for (let i = 0; i < source.length && i < 46; i += 1) {
      if (source[i]) slots.push({ slot: i, name: source[i].name, count: source[i].count });
    }
    return slots;
  }

  hudState({ debug = false, inventory = false } = {}) {
    const bot = this.bot;
    if (!bot || !bot.entity) return { connected: false };
    const hotbar = [];
    for (let i = 0; i < 9; i += 1) {
      const item = bot.inventory && bot.inventory.slots[36 + i];
      hotbar.push(item ? { name: item.name, count: item.count } : null);
    }
    const yaw = bot.entity.yaw || 0;
    const position = bot.entity.position;
    const dayTime = bot.time ? bot.time.timeOfDay : null;
    const sky = skyBrightness(dayTime);
    const light = this.lightInfo(sky);
    const state = {
      connected: true,
      textureVersion: this.textureVersion(bot.version),
      health: bot.health ?? 20,
      maxHealth: 20,
      food: bot.food ?? 20,
      hunger: Boolean(bot.entity.effects && Object.values(bot.entity.effects).some(effect => /hunger/i.test(String(effect.name || effect.id)))),
      xpLevel: bot.experience ? bot.experience.level : 0,
      xpProgress: bot.experience ? bot.experience.progress : 0,
      slot: bot.quickBarSlot ?? 0,
      hotbar,
      pos: { x: position.x, y: position.y, z: position.z },
      yaw,
      pitch: bot.entity.pitch || 0,
      controllable: Boolean(this.controls),
      facing: facingOf(yaw).name,
      dimension: bot.game ? bot.game.dimension : '',
      gameMode: bot.game ? bot.game.gameMode : '',
      dayTime,
      skyBrightness: sky,
      light,
      viewDistance: this.viewDistance,
      eyes: Boolean(this.eyesUrl),
      chat: this.chat
    };
    if (debug) state.debug = this.debugState(position, light);
    if (inventory) state.inventory = this.inventoryState();
    return state;
  }

  stop() {
    this.detach();
    this.io?.close();
    this.server?.close();
    this.server = null;
    this.io = null;
  }

  handleConnection(socket) {
    const bot = this.bot;
    if (!bot || !bot.entity) {
      socket.disconnect(true);
      return;
    }
    this.sockets.add(socket);
    socket.emit('version', bot.version);
    const worldView = new this.WorldView(bot.world, this.viewDistance, bot.entity.position, socket);
    worldView.init(bot.entity.position);

    // The viewer never draws the bot itself (it is the camera). For third person, show its body.
    let bodyShown = false;
    socket.sendSelf = () => {
      if (!bot.entity) return;
      const id = bot.entity.id;
      if (this.selfBody <= 0) {
        if (bodyShown) socket.emit('entity', { id, delete: true });
        bodyShown = false;
        return;
      }
      if (!bodyShown) {
        socket.emit('entity', { id, name: 'player', pos: bot.entity.position, width: bot.entity.width, height: bot.entity.height });
        bodyShown = true;
      }
      socket.emit('entity', { id, pos: bot.entity.position, pitch: bot.entity.pitch, yaw: bot.entity.yaw });
    };

    const sendPosition = () => {
      if (!bot.entity) return;
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true };
      if (this.firstPerson) packet.pitch = bot.entity.pitch;
      socket.emit('position', packet);
      worldView.updatePosition(bot.entity.position);
      socket.sendSelf();
    };

    bot.on('move', sendPosition);
    worldView.listenToBot(bot);
    socket.on('disconnect', () => {
      bot.removeListener('move', sendPosition);
      worldView.removeListenersFromBot(bot);
      this.sockets.delete(socket);
      socket.sendSelf = null;
    });
  }
}

module.exports = { BrowserViewer, secretsMatch, readCookie, facingOf, notchianYawDegrees, skyBrightness, CAMERA_MAX_DISTANCE };
