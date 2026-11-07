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

const COOKIE_NAME = 'viewer_token';

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

class BrowserViewer {
  constructor({ port = 3007, host = '127.0.0.1', token, viewDistance = 6, firstPerson = true, log = console.log } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.viewDistance = viewDistance;
    this.firstPerson = firstPerson;
    this.log = log;
    this.bot = null;
    this.sockets = new Set();
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
    app.use('/', express.static(path.join(viewerPackage, 'public')));

    this.server = http.createServer(app);
    this.io = socketIo(this.server, { path: '/socket.io' });
    this.io.use((socket, next) => {
      if (this.isAuthorized(socket.handshake.headers.cookie, '')) return next();
      return next(new Error('unauthorized'));
    });
    this.io.on('connection', socket => this.handleConnection(socket));

    this.server.on('error', error => this.log(`[Viewer] Server error: ${error.message}`));
    this.server.listen(this.port, this.host, () => {
      this.log(`[Viewer] 3D view on http://${this.host}:${this.server.address().port}/ (token required)`);
    });
    return true;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
  }

  detach() {
    for (const socket of this.sockets) socket.disconnect(true);
    this.sockets.clear();
    this.bot = null;
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
