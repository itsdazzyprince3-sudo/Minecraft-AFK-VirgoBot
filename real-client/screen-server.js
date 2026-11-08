#!/usr/bin/env node
'use strict';

// Shows the REAL Minecraft client's screen in a browser and lets you send chat /
// Baritone commands to it. No npm dependencies: needs Node 18+, ffmpeg, and Python
// with pyautogui (see send-keys.py) for the command box.
//
//   SCREEN_TOKEN=secret node real-client/screen-server.js
//
// Env: SCREEN_TOKEN (required, falls back to DASHBOARD_TOKEN), SCREEN_PORT (3008),
// SCREEN_HOST (127.0.0.1), SCREEN_FPS (12), SCREEN_WIDTH (1280), SCREEN_QUALITY (6,
// lower is sharper), DISPLAY (Linux), SCREEN_WINDOW (Windows window title, default
// whole desktop), SCREEN_INPUT (macOS avfoundation input, default "1:none").

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const PORT = Number(process.env.SCREEN_PORT) || 3008;
const HOST = process.env.SCREEN_HOST || '127.0.0.1';
const TOKEN = process.env.SCREEN_TOKEN || process.env.DASHBOARD_TOKEN || '';
const FPS = Number(process.env.SCREEN_FPS) || 12;
const WIDTH = Number(process.env.SCREEN_WIDTH) || 1280;
const QUALITY = Number(process.env.SCREEN_QUALITY) || 6;
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const SEND_KEYS = path.join(__dirname, 'send-keys.py');
const COOKIE = 'screen_token';
const ALLOWED_KEYS = new Set(['w', 'a', 's', 'd', 'space', 'shift', 'ctrl']);

function secretsMatch(expected, provided) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function captureArgs() {
  const fps = String(FPS);
  let input;
  if (process.platform === 'win32') {
    const title = process.env.SCREEN_WINDOW;
    input = ['-f', 'gdigrab', '-framerate', fps, '-i', title ? `title=${title}` : 'desktop'];
  } else if (process.platform === 'darwin') {
    input = ['-f', 'avfoundation', '-framerate', fps, '-capture_cursor', '1', '-i', process.env.SCREEN_INPUT || '1:none'];
  } else {
    input = ['-f', 'x11grab', '-framerate', fps, '-i', process.env.DISPLAY || ':0'];
  }
  return ['-hide_banner', '-loglevel', 'error', ...input,
    '-vf', `scale=${WIDTH}:-2`, '-q:v', String(QUALITY), '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'];
}

// One ffmpeg process shared by every viewer; started on demand, stopped when idle.
class FrameSource {
  constructor() {
    this.clients = new Set();
    this.proc = null;
    this.buffer = Buffer.alloc(0);
    this.idleTimer = null;
    this.lastError = '';
    this.frames = 0;
  }

  add(res) {
    this.clients.add(res);
    clearTimeout(this.idleTimer);
    if (!this.proc) this.start();
    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.idleTimer = setTimeout(() => this.stop(), 10000);
    });
  }

  start() {
    this.lastError = '';
    this.buffer = Buffer.alloc(0);
    this.proc = spawn('ffmpeg', captureArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', chunk => this.onData(chunk));
    this.proc.stderr.on('data', data => { this.lastError = String(data).trim().slice(-300); });
    this.proc.on('error', error => {
      this.lastError = error.code === 'ENOENT' ? 'ffmpeg is not installed' : error.message;
      this.proc = null;
    });
    this.proc.on('exit', () => {
      this.proc = null;
      if (this.clients.size > 0) setTimeout(() => { if (!this.proc && this.clients.size) this.start(); }, 2000);
    });
  }

  stop() {
    if (this.proc) this.proc.kill('SIGKILL');
    this.proc = null;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) { this.buffer = Buffer.alloc(0); return; }
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end === -1) { this.buffer = this.buffer.subarray(start); return; }
      const frame = this.buffer.subarray(start, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      this.frames += 1;
      for (const res of this.clients) {
        if (res.writableNeedDrain) continue; // drop frames for slow clients
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
        res.write(frame);
        res.write('\r\n');
      }
    }
  }
}

const source = new FrameSource();
let lastCommandAt = 0;

function runSendKeys(args) {
  return new Promise(resolve => {
    execFile(PYTHON, [SEND_KEYS, ...args], { timeout: 15000, env: process.env }, (error, stdout, stderr) => {
      resolve({ ok: !error, message: (stderr || stdout || (error && error.message) || '').toString().trim().slice(-300) });
    });
  });
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minecraft screen</title><style>
body{margin:0;background:#0b0f14;color:#e6edf3;font:14px system-ui,sans-serif}
header{padding:8px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#121821}
#screen{display:block;width:100%;max-height:70vh;object-fit:contain;background:#000}
form{display:flex;gap:6px;flex:1;min-width:240px}input{flex:1;padding:8px;border-radius:6px;border:1px solid #2b3645;background:#0b0f14;color:inherit}
button{padding:8px 10px;border-radius:6px;border:1px solid #2b3645;background:#1b2533;color:inherit;cursor:pointer}
button:active{background:#2b3a52}.pad{display:grid;grid-template-columns:repeat(3,56px);gap:6px;padding:10px 12px}
#status{padding:0 12px 10px;color:#8b98a9}</style></head><body>
<header><form id="f"><input id="t" placeholder="#goto 100 64 200  |  #mine diamond_ore  |  chat text" autocomplete="off" maxlength="256"><button>Send</button></form>
<button data-c="#stop">#stop</button><button data-c="#mine diamond_ore">Mine diamond</button><button data-c="#mine log">Wood</button><button data-c="#cancel">#cancel</button></header>
<img id="screen" alt="Minecraft screen" src="/stream.mjpg">
<div class="pad"><span></span><button data-k="w">W</button><span></span><button data-k="a">A</button><button data-k="s">S</button><button data-k="d">D</button><span></span><button data-k="space">Jump</button><span></span></div>
<div id="status">Commands are typed into the game chat, so the game window must be focused and no menu open.</div>
<script>
const st=document.getElementById('status');
async function post(url,body){try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();st.textContent=j.ok?'Sent.':('Failed: '+(j.message||j.error||r.status));}catch(e){st.textContent='Failed: '+e.message;}}
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();const t=document.getElementById('t');if(t.value.trim()){post('/api/chat',{text:t.value.trim()});t.value='';}});
document.querySelectorAll('[data-c]').forEach(b=>b.addEventListener('click',()=>post('/api/chat',{text:b.dataset.c})));
document.querySelectorAll('[data-k]').forEach(b=>b.addEventListener('click',()=>post('/api/key',{key:b.dataset.k,ms:600})));
document.getElementById('screen').addEventListener('error',()=>{st.textContent='No picture yet. Is the game running? Check the server log.';setTimeout(()=>{document.getElementById('screen').src='/stream.mjpg?'+Date.now();},3000);});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token') || '';
  const authorized = secretsMatch(TOKEN, queryToken) || secretsMatch(TOKEN, readCookie(req.headers.cookie, COOKIE));
  if (!authorized) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Token required. Open /?token=YOUR_TOKEN');
    return;
  }
  if (secretsMatch(TOKEN, queryToken)) {
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Strict`);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stream.mjpg') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store',
      Connection: 'close'
    });
    source.add(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, { ok: true, capturing: Boolean(source.proc), frames: source.frames, error: source.lastError });
    return;
  }
  if (req.method === 'POST' && (url.pathname === '/api/chat' || url.pathname === '/api/key')) {
    if (Date.now() - lastCommandAt < 400) return sendJson(res, 429, { ok: false, message: 'Slow down.' });
    lastCommandAt = Date.now();
    let body;
    try { body = await readJson(req); } catch { return sendJson(res, 400, { ok: false, message: 'Bad request.' }); }
    if (url.pathname === '/api/chat') {
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
        return sendJson(res, 400, { ok: false, message: 'Text must be 1-256 characters with no control characters.' });
      }
      return sendJson(res, 200, await runSendKeys(['chat', text]));
    }
    const key = String(body.key || '');
    const ms = Math.min(Math.max(Number(body.ms) || 400, 50), 3000);
    if (!ALLOWED_KEYS.has(key)) return sendJson(res, 400, { ok: false, message: 'Key not allowed.' });
    return sendJson(res, 200, await runSendKeys(['key', key, String(ms)]));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

if (require.main === module) {
  if (!TOKEN) {
    console.error('[Screen] Set SCREEN_TOKEN (or DASHBOARD_TOKEN) first. Refusing to start without a token.');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => console.log(`[Screen] http://${HOST}:${PORT}/ (token required)`));
  const shutdown = () => { source.stop(); server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { secretsMatch, readCookie, captureArgs };
