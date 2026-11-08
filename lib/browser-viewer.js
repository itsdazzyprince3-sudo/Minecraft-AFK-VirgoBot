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
const CONTROL_ACTIONS = new Set(['attack', 'use', 'slot', 'drop', 'swap_hand']);

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

const WRAPPER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot view</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
#wrap{position:absolute;inset:0;cursor:crosshair}
iframe,canvas{position:absolute;inset:0;width:100%;height:100%;border:0}iframe{pointer-events:none}
canvas{pointer-events:none;image-rendering:pixelated}
#chat-box{display:none;position:absolute;left:8px;right:8px;bottom:8px}
#chat-input{width:100%;box-sizing:border-box;padding:6px 8px;background:rgba(0,0,0,.6);color:#fff;border:1px solid #888;font:16px monospace;outline:none}</style></head>
<body><div id="wrap"><iframe id="world" src="/" title="World"></iframe><canvas id="hud"></canvas>
<div id="chat-box"><input id="chat-input" maxlength="200" autocomplete="off" placeholder="Say something (Enter sends, Esc cancels)"></div></div>
<script src="/socket.io/socket.io.js"></script><script src="/hud.js"></script><script src="/controls.js"></script></body></html>`;

class BrowserViewer {
  constructor({ port = 3007, host = '127.0.0.1', token, viewDistance = 6, firstPerson = true, controls = null, log = console.log } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.viewDistance = viewDistance;
    this.firstPerson = firstPerson;
    this.controls = controls;
    this.log = log;
    this.bot = null;
    this.sockets = new Set();
    this.chat = [];
    this.viewerPackage = null;
    this.onChat = message => {
      this.chat.push({ t: Date.now(), text: String(message).slice(0, 120) });
      if (this.chat.length > 20) this.chat.shift();
    };
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
    app.use(compression());
    app.get('/watch', (req, res) => res.type('html').send(WRAPPER_PAGE));
    app.get('/hud.js', (req, res) => res.type('js').send(fs.readFileSync(path.join(__dirname, 'viewer-hud.js'))));
    app.get('/controls.js', (req, res) => res.type('js').send(fs.readFileSync(path.join(__dirname, 'viewer-controls.js'))));
    app.get('/api/hud', (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(this.hudState());
    });
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
    bot.on('messagestr', this.onChat);
  }

  detach() {
    for (const socket of this.sockets) socket.disconnect(true);
    this.sockets.clear();
    if (this.bot) this.bot.removeListener('messagestr', this.onChat);
    this.bot = null;
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
        return controls.action(payload.action, payload.action === 'slot' ? { slot: Number.isInteger(slot) ? slot : 0 } : {});
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
      socket.on('disconnect', () => {
        clearInterval(refill);
        try { controls.release(); } catch { /* bot already gone */ }
      });
    });
  }

  textureVersion(version) {
    const root = this.viewerPackage && path.join(this.viewerPackage, 'public', 'textures');
    if (root && version && fs.existsSync(path.join(root, version, 'gui', 'sprites', 'hud', 'hotbar.png'))) return version;
    return '1.21.4'; // HUD sprites are the same across 1.21.x
  }

  hudState() {
    const bot = this.bot;
    if (!bot || !bot.entity) return { connected: false };
    const hotbar = [];
    for (let i = 0; i < 9; i += 1) {
      const item = bot.inventory && bot.inventory.slots[36 + i];
      hotbar.push(item ? { name: item.name, count: item.count } : null);
    }
    const yaw = bot.entity.yaw || 0;
    const facing = ['south', 'west', 'north', 'east'][Math.round((((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4];
    const position = bot.entity.position;
    return {
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
      facing,
      dimension: bot.game ? bot.game.dimension : '',
      gameMode: bot.game ? bot.game.gameMode : '',
      dayTime: bot.time ? bot.time.timeOfDay : null,
      chat: this.chat
    };
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

    const sendPosition = () => {
      if (!bot.entity) return;
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true };
      if (this.firstPerson) packet.pitch = bot.entity.pitch;
      socket.emit('position', packet);
      worldView.updatePosition(bot.entity.position);
    };

    bot.on('move', sendPosition);
    worldView.listenToBot(bot);
    socket.on('disconnect', () => {
      bot.removeListener('move', sendPosition);
      worldView.removeListenersFromBot(bot);
      this.sockets.delete(socket);
    });
  }
}

module.exports = { BrowserViewer, secretsMatch, readCookie };
