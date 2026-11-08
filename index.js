'use strict';

require('./lib/protocol-compat');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalNearXZ } = goals;
const { AIAgent } = require('./lib/ai-agent');
const {
  createTrustedChatMemoryNote,
  getAIChatAllowedUsers,
  isAIChatAuthorized,
  parseAIChatCommand
} = require('./lib/ai-chat');
const { parseLocalIntent } = require('./lib/ai-brain');
const { detectLanguage, reply: localizedReply } = require('./lib/ai-nlp');
const { isPatrolEnabled, runPatrol } = require('./lib/patrol');
const { ManualControlSession } = require('./lib/manual-controls');
const { installProtocolPacketCompatibility } = require('./lib/protocol-packet-compat');
const pluginLoader = require('./lib/plugin-loader');
const { FrameServer } = require('./lib/frame-server');
const { VisionController } = require('./lib/vision-controller');
const settingsPath = require('node:path').join(__dirname, 'settings.json');
if (!fs.existsSync(settingsPath)) {
  throw new Error('Missing settings.json. Copy settings.example.json to settings.json and configure your server before starting the bot.');
}
const config = require(settingsPath);
const express = require('express');
const http = require('http');
const https = require('https');
const { resolveBotVersion } = require('./lib/version');

const app = express();
app.use(express.json({ limit: '8kb' }));
const PORT = process.env.PORT || 5000;

let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let blockAtGuardTimer = null;
let consoleCommandsInitialized = false;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  lastDisconnectReason: null,
  serverOffline: false,
  errors: [],
  wasThrottled: false,
  duplicateLogin: false
};

const manualControlSession = new ManualControlSession({
  getBot: () => bot,
  isConnected: () => botState.connected,
  onExpire: error => {
    if (error) console.log(`[Controls] Failed to release expired inputs: ${error.message}`);
    else console.log('[Controls] Input lease expired; released held controls.');
  }
});
const manualControls = manualControlSession.active;

const chatQueue = [];
let isProcessingChatQueue = false;
let lastChatSentAt = 0;
const MIN_CHAT_INTERVAL_MS = 1200;

function enqueueSafeChat(message, rawSender) {
  if (!message) return;
  chatQueue.push({ message, rawSender });
  processChatQueue();
}

function processChatQueue() {
  if (isProcessingChatQueue || !chatQueue.length || !bot || !botState.connected) return;
  const now = Date.now();
  const wait = Math.max(0, MIN_CHAT_INTERVAL_MS - (now - lastChatSentAt));
  isProcessingChatQueue = true;
  setTimeout(() => {
    isProcessingChatQueue = false;
    if (!bot || !botState.connected) {
      chatQueue.length = 0;
      return;
    }
    const item = chatQueue.shift();
    if (item && item.message) {
      lastChatSentAt = Date.now();
      try {
        if (typeof item.rawSender === 'function') {
          item.rawSender(item.message);
        } else if (typeof bot?._rawChat === 'function') {
          bot._rawChat(item.message);
        } else if (typeof bot?.chat === 'function') {
          bot.chat(item.message);
        }
      } catch (err) {
        console.log(`[ChatQueue] Could not send: ${err.message}`);
      }
    }
    if (chatQueue.length > 0) {
      processChatQueue();
    }
  }, wait);
}

function sendAIChatMessage(message) {
  if (!bot || !botState.connected) return;
  const text = String(message).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
  if (!text) return;
  enqueueSafeChat(`[${bot.username || 'Virgo'}] ${text}`);
}

const aiAgent = new AIAgent({
  config: config.ai || {},
  getBot: () => bot,
  isConnected: () => botState.connected,
  onUpdate: (status, requester) => {
    if (!requester || !['completed', 'error', 'stopped'].includes(status.status)) return;
    const response = status.status === 'error'
      ? `I couldn't complete that: ${status.message}`
      : status.message;
    sendAIChatMessage(`${requester}: ${response}`);
  },
  onProgress: (message, requester, { autonomous } = {}) => {
    if (!requester || autonomous || config.ai?.chatProgress === false || config.ai?.autonomous?.chatProgress === false) return;
    sendAIChatMessage(message);
  }
});

pluginLoader.init({ config, aiAgent });

// First-person viewer bridge (opt-in): the C++ renderer draws what the bot sees
// and sends back PERC, a compact perception summary the reflex layer plays from.
const path = require('node:path');
const { spawn } = require('node:child_process');
const viewEnabled = process.env.BOT_VIEW === '1' || config.view?.enabled === true;
const viewConfig = config.view || {};
const viewFrameServer = viewEnabled
  ? new FrameServer({
      getBot: () => bot,
      isConnected: () => botState.connected,
      port: Number(process.env.VIEW_FRAME_PORT) || viewConfig.port || 31337,
      w: Number(process.env.VIEW_W) || viewConfig.w || 64,
      h: Number(process.env.VIEW_H) || viewConfig.h || 48,
      d: Number(process.env.VIEW_D) || viewConfig.d || 64,
      tickHz: Number(process.env.VIEW_TICK_HZ) || viewConfig.tickHz || 20
    })
  : null;
if (viewFrameServer) {
  viewFrameServer.on('perception', (perception) => {
    if (bot) bot.aiPerception = perception;
  });
  viewFrameServer.start();
}

// Spawn the C++ viewer alongside the bot unless told not to. It reconnects to
// the frame server by itself; we only restart it if the process dies.
let viewerProcess = null;
let viewerRestarts = 0;
let viewerStartedAt = 0;
function startViewerProcess() {
  if (!viewEnabled || viewConfig.spawn === false || viewerProcess) return;
  const binary = path.join(__dirname, viewConfig.binary || 'cpp/bot_view');
  if (!fs.existsSync(binary)) {
    console.log('[View] viewer binary missing - build with: g++ -O2 -std=c++17 -pthread cpp/bot_view.cpp -o cpp/bot_view');
    return;
  }
  const args = [
    '--frame-port', String(viewFrameServer ? viewFrameServer.port : 31337),
    '--http-port', String(Number(process.env.VIEW_HTTP_PORT) || viewConfig.httpPort || 8080),
    '--w', String(Number(process.env.VIEW_RENDER_W) || viewConfig.renderWidth || 320),
    '--h', String(Number(process.env.VIEW_RENDER_H) || viewConfig.renderHeight || 180),
    '--fps', String(Number(process.env.VIEW_RENDER_FPS) || viewConfig.renderFps || 60),
    '--stream-fps', String(Number(process.env.VIEW_STREAM_FPS) || viewConfig.streamFps || 30),
    '--quality', String(Number(process.env.VIEW_QUALITY) || viewConfig.quality || 70)
  ];
  if (viewConfig.threads || process.env.VIEW_THREADS) {
    args.push('--threads', String(Number(process.env.VIEW_THREADS) || viewConfig.threads));
  }
  try {
    viewerProcess = spawn(binary, args, { stdio: 'inherit' });
    viewerStartedAt = Date.now();
    console.log(`[View] viewer started (${args.join(' ')})`);
  } catch (err) {
    console.log(`[View] could not start viewer: ${err.message}`);
    return;
  }
  viewerProcess.on('exit', (code, signal) => {
    viewerProcess = null;
    if (isShuttingDown) return;
    const ranFor = Date.now() - viewerStartedAt;
    viewerRestarts = ranFor > 30000 ? 1 : viewerRestarts + 1;
    if (viewerRestarts > 5) {
      console.log(`[View] viewer exited (${code ?? signal}) repeatedly; not restarting. Build it with cpp/README.md.`);
      return;
    }
    console.log(`[View] viewer exited (${code ?? signal}); restarting in 3s`);
    setTimeout(startViewerProcess, 3000).unref?.();
  });
}
if (viewEnabled) startViewerProcess();

// Vision control: reflex layer plays from PERC in real time; the LLM layer is
// opt-in (config.vision.llm or VISION_LLM=1) because it is slow on CPU hosts.
// Toggle in-game: !ai vision on/off.
function createVisionController() {
  return new VisionController({
    getBot: () => bot,
    isConnected: () => botState.connected,
    getPerception: viewFrameServer ? () => viewFrameServer.lastPerception : null,
    viewerUrl: process.env.VIEWER_URL || viewConfig.url || 'http://127.0.0.1:8080',
    ollamaUrl: process.env.OLLAMA_URL || config.ai?.ollama?.url || 'http://127.0.0.1:11434/api/chat',
    model: process.env.VISION_MODEL || config.vision?.model || 'llava',
    intervalMs: Number(process.env.VISION_INTERVAL) || config.vision?.intervalMs || 4000,
    reflexHz: Number(process.env.VISION_REFLEX_HZ) || config.vision?.reflexHz || 10,
    reflex: process.env.VISION_REFLEX !== '0' && config.vision?.reflex !== false,
    llm: process.env.VISION_LLM === '1' || config.vision?.llm === true,
    dryRun: process.env.VISION_DRY === '1' || config.vision?.dryRun === true,
    enabled: true,
    onLog: (m) => console.log(`[Vision] ${m}`)
  });
}
let visionController = null;
if (viewEnabled || config.vision?.enabled === true) {
  visionController = createVisionController();
  visionController.start();
}

function hasDashboardAccess(req) {
  const expected = process.env.DASHBOARD_TOKEN;
  const provided = req.get('x-dashboard-token') || '';
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function pushError(entry) {
  botState.errors.push(entry);
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
          :root {
            --bg: #0f172a;
            --container-bg: #111827;
            --card-bg: #1f2937;
            --accent: #2dd4bf;
            --text-main: #f8fafc;
            --text-dim: #94a3b8;
          }
          body {
            font-family: 'Inter', sans-serif;
            background: var(--bg);
            color: var(--text-main);
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
          }
          .container {
            background: var(--container-bg);
            padding: 3rem 2rem;
            border-radius: 2rem;
            width: 420px;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
            border: 1px solid #1f2937;
            text-align: center;
          }
          h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 2.5rem; color: #f1f5f9; }
          .card {
            background: var(--card-bg);
            border-radius: 1rem;
            padding: 1.25rem 1.75rem;
            margin-bottom: 1rem;
            text-align: left;
            border-left: 4px solid var(--accent);
            transition: transform 0.2s;
          }
          .card:hover { transform: translateX(5px); }
          .label { font-size: 0.75rem; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
          .value { font-size: 1.25rem; font-weight: 700; color: var(--accent); display: flex; align-items: center; gap: 0.5rem; }
          .dot { width: 12px; height: 12px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 10px #4ade80; display: inline-block; }
          .dot.offline { background: #f87171; box-shadow: 0 0 10px #f87171; }
          .pulse { animation: pulse-animation 2s infinite; }
          @keyframes pulse-animation {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(74,222,128,0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(74,222,128,0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(74,222,128,0); }
          }
          .offline.pulse { animation: pulse-offline 2s infinite; }
          @keyframes pulse-offline {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(248,113,113,0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(248,113,113,0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(248,113,113,0); }
          }
          .btn {
            display: inline-flex; align-items: center; justify-content: center; gap: 0.75rem;
            background: var(--accent); color: #0f172a; padding: 1rem 2rem; border-radius: 1rem;
            font-weight: 700; text-decoration: none; margin-top: 1.5rem; transition: all 0.2s;
            box-shadow: 0 0 20px rgba(45,212,191,0.4); width: 100%; box-sizing: border-box;
          }
          .btn:hover { transform: translateY(-2px); box-shadow: 0 0 30px rgba(45,212,191,0.6); filter: brightness(1.1); }
          textarea, input { width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #475569; border-radius: 0.6rem; color: var(--text-main); padding: 0.75rem; font: inherit; margin: 0.4rem 0 0.8rem; }
          textarea { min-height: 90px; resize: vertical; }
          button { cursor: pointer; border: 0; }
          .ai-status { font-size: 0.9rem; color: var(--text-dim); overflow-wrap: anywhere; }
          .control-help { color: var(--text-dim); font-size: 0.85rem; line-height: 1.5; }
          .control-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; max-width: 260px; margin: 1rem auto; }
          .control-key { min-height: 48px; border-radius: 0.6rem; background: #334155; color: var(--text-main); font: inherit; font-weight: 700; touch-action: none; user-select: none; }
          .control-key:active, .control-key.active { background: var(--accent); color: #0f172a; }
          .control-key:disabled { opacity: 0.45; cursor: not-allowed; }
          .control-status { min-height: 1.2em; color: var(--text-dim); font-size: 0.85rem; }
          .disconnect-reason { color: #fca5a5; font-size: 0.85rem; overflow-wrap: anywhere; }
          .footer { margin-top: 1.5rem; font-size: 0.8125rem; color: #4b5563; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>${config.name}</h1>
          <div class="card">
            <div class="label">Status</div>
            <div class="value">
              <span id="status-dot" class="dot pulse"></span>
              <span id="status-text">Connecting...</span>
            </div>
          </div>
          <div class="card">
            <div class="label">Uptime</div>
            <div class="value" id="uptime-text">0h 0m 0s</div>
          </div>
          <div class="card">
            <div class="label">Coordinates</div>
            <div class="value">
              <span id="coords-text">Searching...</span>
            </div>
          </div>
          <div class="card">
            <div class="label">Server</div>
            <div class="value" style="font-size:1.1rem;color:#5eead4;">${config.server.ip}</div>
          </div>
          <div class="card" id="offline-warning-card" style="border-left: 4px solid #ef4444; background: #26171a;" hidden>
            <div class="label" style="color: #ef4444;">⚠️ SERVER OFFLINE</div>
            <div style="font-weight: 700; color: #fca5a5; margin-bottom: 0.35rem;">Minecraft Server is Offline!</div>
            <div style="font-size: 0.85rem; color: #fecdd3; line-height: 1.4;">Please turn on your server in your host dashboard. The bot will NOT stop reconnecting and will connect automatically once the server is online.</div>
          </div>
          <div class="card" id="disconnect-card" hidden>
            <div class="label">Last disconnect reason</div>
            <div class="disconnect-reason" id="disconnect-reason"></div>
          </div>
          <div class="card" id="radar-card">
            <div class="label">Live Radar & Status</div>
            <div style="display:flex;flex-wrap:wrap;gap:1.2rem;align-items:center;justify-content:center;margin-top:0.5rem;">
              <div style="position:relative;width:240px;height:240px;background:#090d16;border-radius:50%;border:2px solid #334155;overflow:hidden;box-shadow:inset 0 0 20px rgba(0,0,0,0.8);">
                <canvas id="radar-canvas" width="240" height="240"></canvas>
              </div>
              <div style="flex:1;min-width:180px;">
                <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:4px;">Vitals:</div>
                <div style="margin-bottom:8px;">
                  <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:2px;">
                    <span>Health</span><span id="vitals-hp">20 / 20</span>
                  </div>
                  <div style="background:#1e293b;border-radius:4px;height:10px;overflow:hidden;">
                    <div id="hp-bar" style="background:#ef4444;height:100%;width:100%;transition:width 0.3s;"></div>
                  </div>
                </div>
                <div style="margin-bottom:8px;">
                  <div style="display:flex;justify-content:space-between;font-size:0.75rem;margin-bottom:2px;">
                    <span>Food</span><span id="vitals-food">20 / 20</span>
                  </div>
                  <div style="background:#1e293b;border-radius:4px;height:10px;overflow:hidden;">
                    <div id="food-bar" style="background:#f59e0b;height:100%;width:100%;transition:width 0.3s;"></div>
                  </div>
                </div>
                <div style="font-size:0.8rem;color:var(--text-dim);margin-top:8px;line-height:1.5;">
                  <div>Held: <span id="held-item" style="color:var(--text-main);font-weight:600;">None</span></div>
                  <div>Nearby: <span id="radar-summary" style="color:var(--text-main);">0 entities</span></div>
                  <div>Legend: <span style="color:#38bdf8;">● Player</span> <span style="color:#ef4444;">● Hostile</span> <span style="color:#22c55e;">● Passive</span> <span style="color:#fbbf24;">● Item</span></div>
                </div>
              </div>
            </div>
            <div style="margin-top:14px;">
              <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:4px;">Hotbar:</div>
              <div id="hotbar-slots" style="display:grid;grid-template-columns:repeat(9,1fr);gap:4px;">
              </div>
            </div>
          </div>
          <div class="card">
            <div class="label">Manual bot controls</div>
            <p class="control-help">Use W/A/S/D to move, Space to jump, Shift to sneak, Ctrl to sprint. Press Q to drop held items, Left-Click to attack/mine, Right-Click to use/place, F to swap offhand, and 1-9 for hotbar slots.</p>
            <div class="control-grid" aria-label="Movement controls">
              <span></span><button class="control-key" type="button" data-control="forward">W / ↑</button><span></span>
              <button class="control-key" type="button" data-control="left">A / ←</button>
              <button class="control-key" type="button" data-control="back">S / ↓</button>
              <button class="control-key" type="button" data-control="right">D / →</button>
              <button class="control-key" type="button" data-control="jump">Jump (Space)</button>
              <button class="control-key" type="button" data-control="sneak">Sneak (Shift)</button>
              <button class="control-key" type="button" data-control="sprint">Sprint (Ctrl)</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px;">
              <button class="control-key action-btn" type="button" data-action="attack">⚔️ Attack (L-Click)</button>
              <button class="control-key action-btn" type="button" data-action="use">🛡️ Use / Place (R-Click)</button>
              <button class="control-key action-btn" type="button" data-action="drop">🎁 Drop (Q)</button>
              <button class="control-key action-btn" type="button" data-action="swap_hand">🔄 Swap Hand (F)</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(9,1fr);gap:4px;margin-top:8px;">
              <button class="control-key slot-btn" type="button" data-slot="1">1</button>
              <button class="control-key slot-btn" type="button" data-slot="2">2</button>
              <button class="control-key slot-btn" type="button" data-slot="3">3</button>
              <button class="control-key slot-btn" type="button" data-slot="4">4</button>
              <button class="control-key slot-btn" type="button" data-slot="5">5</button>
              <button class="control-key slot-btn" type="button" data-slot="6">6</button>
              <button class="control-key slot-btn" type="button" data-slot="7">7</button>
              <button class="control-key slot-btn" type="button" data-slot="8">8</button>
              <button class="control-key slot-btn" type="button" data-slot="9">9</button>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px;">
              <button class="control-key aim-btn" type="button" data-aim="up">Look Up</button>
              <button class="control-key aim-btn" type="button" data-aim="down">Look Down</button>
              <button class="control-key aim-btn" type="button" data-aim="left">Look Left</button>
              <button class="control-key aim-btn" type="button" data-aim="right">Look Right</button>
            </div>
            <p class="control-status" id="control-status" aria-live="polite">Enter the dashboard token to enable controls.</p>
          </div>
          <div class="card">
            <div class="label">AI instruction</div>
            <p class="ai-status">${config.ai?.enabled ? 'AI mode is enabled. Virgo accepts trusted chat tasks, defends against hostile mobs, retreats at low health, and can recover nearby death drops.' : 'AI mode is disabled. Enable it in settings.json and configure the model API before submitting tasks.'}</p>
            <label for="dashboard-token">Dashboard control token</label>
            <input id="dashboard-token" type="password" autocomplete="off" placeholder="DASHBOARD_TOKEN">
            <label for="instruction">What should the bot do?</label>
            <textarea id="instruction" maxlength="500" placeholder="Mine enough stone for a furnace"></textarea>
            <button class="btn" id="submit-instruction" type="button">Start instruction</button>
            <button class="btn" id="stop-instruction" type="button">Stop</button>
            <div style="margin-top:12px;">
              <div style="font-size:0.8rem;color:var(--text-dim);margin-bottom:6px;">Quick AI Macros:</div>
              <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">
                <button class="control-key macro-btn" type="button" data-macro="guard me">🛡️ Guard Me</button>
                <button class="control-key macro-btn" type="button" data-macro="sort chests">📦 Sort Chests</button>
                <button class="control-key macro-btn" type="button" data-macro="inspect storage">🔍 Index Storage</button>
                <button class="control-key macro-btn" type="button" data-macro="farm">🌾 Auto Farm & Bread</button>
                <button class="control-key macro-btn" type="button" data-macro="build tower">🏰 Build Tower</button>
                <button class="control-key macro-btn" type="button" data-macro="strip mine 16">⛏️ Strip Mine 16</button>
              </div>
            </div>
            <p class="ai-status" id="ai-status">Enter your dashboard control token to view task status.</p>
          </div>
          <a href="/tutorial" class="btn">View Setup Guide</a>
          <div class="footer">Auto-refreshing every 5s</div>
        </div>
        <script>
          const statusText = document.getElementById('status-text');
          const statusDot  = document.getElementById('status-dot');
          const uptimeText = document.getElementById('uptime-text');
          const coordsText = document.getElementById('coords-text');
          const disconnectCard = document.getElementById('disconnect-card');
          const disconnectReason = document.getElementById('disconnect-reason');
          const offlineWarningCard = document.getElementById('offline-warning-card');
          const controlStatus = document.getElementById('control-status');
          const controlButtons = [...document.querySelectorAll('[data-control]')];
          const activeControls = new Set();
          const keyControls = new Map([
            ['w', 'forward'], ['arrowup', 'forward'],
            ['s', 'back'], ['arrowdown', 'back'],
            ['a', 'left'], ['arrowleft', 'left'],
            ['d', 'right'], ['arrowright', 'right'],
            [' ', 'jump'], ['spacebar', 'jump'],
            ['shift', 'sneak'], ['control', 'sprint']
          ]);

          function formatUptime(s) {
            const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
            return h + 'h ' + m + 'm ' + sec + 's';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              if (data.status === 'connected') {
                statusText.innerText = 'Online & Running';
                statusDot.className = 'dot pulse';
                if (offlineWarningCard) offlineWarningCard.hidden = true;
              } else if (data.serverOffline) {
                statusText.innerText = 'Server Offline (Retrying...)';
                statusDot.className = 'dot offline pulse';
                if (offlineWarningCard) offlineWarningCard.hidden = false;
              } else {
                statusText.innerText = 'Reconnecting...';
                statusDot.className = 'dot offline pulse';
                if (offlineWarningCard) offlineWarningCard.hidden = true;
              }
              uptimeText.innerText = formatUptime(data.uptime);
              if (data.coords) {
                coordsText.innerText = Math.floor(data.coords.x) + ', ' + Math.floor(data.coords.y) + ', ' + Math.floor(data.coords.z);
              } else {
                coordsText.innerText = 'Searching Position...';
              }
              if (data.lastDisconnectReason) {
                disconnectReason.innerText = data.lastDisconnectReason;
                disconnectCard.hidden = false;
              }
              if (data.status !== 'connected' && activeControls.size) {
                releaseAllControls('Bot disconnected; movement keys released.');
              }
            } catch (e) {
              statusText.innerText = 'System Offline';
              statusDot.className = 'dot offline';
            }
          }

          setInterval(update, 5000);
          update();

          const instructionInput = document.getElementById('instruction');
          const dashboardTokenInput = document.getElementById('dashboard-token');
          const aiStatus = document.getElementById('ai-status');
          async function aiRequest(path, body) {
            const headers = { 'x-dashboard-token': dashboardTokenInput.value };
            if (body) headers['Content-Type'] = 'application/json';
            const response = await fetch(path, {
              method: body ? 'POST' : 'GET',
              headers,
              body: body ? JSON.stringify(body) : undefined
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Request failed.');
            return result;
          }
          let controlQueue = Promise.resolve();
          function setControl(input, pressed) {
            if (pressed && activeControls.has(input)) return;
            if (!pressed && !activeControls.has(input)) return;
            if (!dashboardTokenInput.value) {
              controlStatus.innerText = 'Enter DASHBOARD_TOKEN to use movement controls.';
              return;
            }
            if (pressed) activeControls.add(input);
            else activeControls.delete(input);
            controlButtons.forEach(button => {
              button.classList.toggle('active', activeControls.has(button.dataset.control));
            });
            controlStatus.innerText = activeControls.size
              ? 'Manual movement active: ' + [...activeControls].join(', ')
              : 'Patrol will resume.';
            controlQueue = controlQueue.then(async () => {
              const result = await aiRequest('/api/control/input', { input, pressed });
              controlStatus.innerText = result.message;
            }).catch(error => {
              controlStatus.innerText = error.message;
              if (pressed) activeControls.delete(input);
              else activeControls.add(input);
              controlButtons.forEach(button => {
                button.classList.toggle('active', activeControls.has(button.dataset.control));
              });
            });
          }
          function releaseAllControls(message) {
            const held = [...activeControls];
            activeControls.clear();
            controlButtons.forEach(button => button.classList.remove('active'));
            if (message) controlStatus.innerText = message;
            if (!held.length || !dashboardTokenInput.value) return;
            controlQueue = controlQueue.then(() =>
              aiRequest('/api/control/release', {})
            ).catch(error => {
              controlStatus.innerText = error.message;
            });
          }
          const actionButtons = [...document.querySelectorAll('[data-action]')];
          const slotButtons = [...document.querySelectorAll('[data-slot]')];
          const aimButtons = [...document.querySelectorAll('[data-aim]')];
          const allInteractiveButtons = [...controlButtons, ...actionButtons, ...slotButtons, ...aimButtons];

          async function performAction(action, payload = {}) {
            if (!dashboardTokenInput.value) {
              controlStatus.innerText = 'Enter DASHBOARD_TOKEN to use controls.';
              return;
            }
            try {
              const res = await aiRequest('/api/control/action', { action, payload });
              controlStatus.innerText = res.message || ('Action ' + action + ' executed.');
            } catch (err) {
              controlStatus.innerText = err.message;
            }
          }

          actionButtons.forEach(btn => {
            btn.addEventListener('click', () => performAction(btn.dataset.action));
          });
          slotButtons.forEach(btn => {
            btn.addEventListener('click', () => performAction('slot', { slot: parseInt(btn.dataset.slot, 10) - 1 }));
          });
          aimButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
              const dir = btn.dataset.aim;
              try {
                const health = await fetch('/health');
                const hData = await health.json();
                const coords = hData.coords || { x: 0, y: 64, z: 0 };
                let target = { ...coords };
                if (dir === 'up') target.y += 10;
                else if (dir === 'down') target.y -= 10;
                else if (dir === 'left') target.x -= 10;
                else if (dir === 'right') target.x += 10;
                await performAction('lookAt', target);
              } catch (e) {
                await performAction('aim', { dir });
              }
            });
          });

          for (const button of controlButtons) {
            const input = button.dataset.control;
            button.addEventListener('pointerdown', event => {
              event.preventDefault();
              button.setPointerCapture(event.pointerId);
              setControl(input, true);
            });
            button.addEventListener('pointerup', () => setControl(input, false));
            button.addEventListener('pointercancel', () => setControl(input, false));
            button.addEventListener('lostpointercapture', () => setControl(input, false));
          }

          document.addEventListener('keydown', event => {
            if (event.target.matches('input, textarea, select, [contenteditable="true"]')) return;
            const key = event.key.toLowerCase();
            if (key === 'q') {
              event.preventDefault();
              performAction('drop', { count: event.ctrlKey ? 64 : 1 });
              return;
            }
            if (key === 'f') {
              event.preventDefault();
              performAction('swap_hand');
              return;
            }
            if (key >= '1' && key <= '9') {
              event.preventDefault();
              performAction('slot', { slot: parseInt(key, 10) - 1 });
              return;
            }
            const input = keyControls.get(key);
            if (!input) return;
            event.preventDefault();
            if (!event.repeat) setControl(input, true);
          });
          document.addEventListener('keyup', event => {
            const input = keyControls.get(event.key.toLowerCase());
            if (input) {
              event.preventDefault();
              setControl(input, false);
            }
          });
          window.addEventListener('blur', () => releaseAllControls('Window unfocused; movement keys released.'));
          window.addEventListener('pagehide', () => releaseAllControls('Page closed; movement keys released.'));
          setInterval(() => {
            if (!activeControls.size || !dashboardTokenInput.value) return;
            controlQueue = controlQueue.then(async () => {
              const result = await aiRequest('/api/control/heartbeat', {});
              if (!result.active.length) {
                activeControls.clear();
                controlButtons.forEach(button => button.classList.remove('active'));
                controlStatus.innerText = 'Movement lease expired; press a control again.';
              }
            }).catch(error => {
              controlStatus.innerText = error.message;
              releaseAllControls('Movement control connection lost; keys released.');
            });
          }, 1000);
          dashboardTokenInput.addEventListener('input', () => {
            const enabled = Boolean(dashboardTokenInput.value);
            allInteractiveButtons.forEach(button => { button.disabled = !enabled; });
            if (!enabled) releaseAllControls('Enter the dashboard token to enable controls.');
          });
          allInteractiveButtons.forEach(button => { button.disabled = true; });
          async function refreshAIStatus() {
            if (!dashboardTokenInput.value) return;
            try {
              const result = await aiRequest('/api/agent/status');
              const latestActions = (result.actions || []).slice(-3)
                .map(action => action.action + ': ' + action.result).join(' | ');
              aiStatus.innerText = result.message + ' (' + result.status + ')' +
                (latestActions ? ' - ' + latestActions : '');
            } catch (error) {
              aiStatus.innerText = error.message;
            }
          }
          if (instructionInput) {
            document.getElementById('submit-instruction').addEventListener('click', async () => {
              try {
                const result = await aiRequest('/api/instruction', { instruction: instructionInput.value });
                aiStatus.innerText = result.message + ' (' + result.status + ')';
              } catch (error) {
                aiStatus.innerText = error.message;
              }
            });
            document.getElementById('stop-instruction').addEventListener('click', async () => {
              try {
                const result = await aiRequest('/api/agent/stop', {});
                aiStatus.innerText = result.message + ' (' + result.status + ')';
              } catch (error) {
                aiStatus.innerText = error.message;
              }
            });
            dashboardTokenInput.addEventListener('change', refreshAIStatus);
            setInterval(refreshAIStatus, 5000);
          }

          const macroButtons = [...document.querySelectorAll('[data-macro]')];
          macroButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
              if (instructionInput) instructionInput.value = btn.dataset.macro;
              try {
                const res = await aiRequest('/api/instruction', { instruction: btn.dataset.macro });
                aiStatus.innerText = res.message + ' (' + res.status + ')';
              } catch (err) {
                aiStatus.innerText = err.message;
              }
            });
          });

          const radarCanvas = document.getElementById('radar-canvas');
          const radarCtx = radarCanvas ? radarCanvas.getContext('2d') : null;
          const hpBar = document.getElementById('hp-bar');
          const foodBar = document.getElementById('food-bar');
          const vitalsHp = document.getElementById('vitals-hp');
          const vitalsFood = document.getElementById('vitals-food');
          const heldItemText = document.getElementById('held-item');
          const radarSummary = document.getElementById('radar-summary');
          const hotbarSlotsDiv = document.getElementById('hotbar-slots');

          async function updateRadar() {
            if (!radarCtx) return;
            try {
              const res = await fetch('/api/radar');
              const data = await res.json();
              if (!data.connected) {
                radarCtx.clearRect(0, 0, 240, 240);
                radarCtx.fillStyle = '#64748b';
                radarCtx.font = '12px sans-serif';
                radarCtx.textAlign = 'center';
                radarCtx.fillText('Bot Disconnected', 120, 120);
                if (radarSummary) radarSummary.innerText = 'Bot offline';
                return;
              }

              const hp = data.health != null ? Math.round(data.health) : 20;
              const food = data.food != null ? Math.round(data.food) : 20;
              if (vitalsHp) vitalsHp.innerText = hp + ' / 20';
              if (vitalsFood) vitalsFood.innerText = food + ' / 20';
              if (hpBar) hpBar.style.width = Math.max(0, Math.min(100, (hp / 20) * 100)) + '%';
              if (foodBar) foodBar.style.width = Math.max(0, Math.min(100, (food / 20) * 100)) + '%';
              if (heldItemText) {
                heldItemText.innerText = data.heldItem ? (data.heldItem.name.replace(/_/g, ' ') + ' (x' + data.heldItem.count + ')') : 'None';
              }

              if (hotbarSlotsDiv && Array.isArray(data.hotbar)) {
                hotbarSlotsDiv.innerHTML = '';
                data.hotbar.forEach(function(item, idx) {
                  const el = document.createElement('div');
                  el.style.background = item.selected ? '#0d9488' : '#1e293b';
                  el.style.border = item.selected ? '2px solid #2dd4bf' : '1px solid #334155';
                  el.style.borderRadius = '4px';
                  el.style.padding = '4px 2px';
                  el.style.textAlign = 'center';
                  el.style.fontSize = '0.65rem';
                  el.style.minHeight = '32px';
                  el.style.display = 'flex';
                  el.style.flexDirection = 'column';
                  el.style.justifyContent = 'space-between';
                  el.title = item.displayName || 'Slot ' + (idx + 1);

                  const slotNum = document.createElement('span');
                  slotNum.style.color = '#94a3b8';
                  slotNum.style.fontSize = '0.6rem';
                  slotNum.innerText = (idx + 1);

                  const itemName = document.createElement('span');
                  itemName.style.color = item.name ? '#f8fafc' : '#475569';
                  itemName.style.overflow = 'hidden';
                  itemName.style.textOverflow = 'ellipsis';
                  itemName.style.whiteSpace = 'nowrap';
                  itemName.innerText = item.name ? item.name.split('_')[0].slice(0, 5) : '-';

                  const countSpan = document.createElement('span');
                  countSpan.style.color = '#2dd4bf';
                  countSpan.style.fontWeight = 'bold';
                  countSpan.innerText = item.count > 1 ? item.count : '';

                  el.appendChild(slotNum);
                  el.appendChild(itemName);
                  el.appendChild(countSpan);
                  hotbarSlotsDiv.appendChild(el);
                });
              }

              radarCtx.clearRect(0, 0, 240, 240);
              const cx = 120, cy = 120;
              const scale = 110 / 32;

              radarCtx.strokeStyle = '#1e293b';
              radarCtx.lineWidth = 1;
              [8, 16, 24, 32].forEach(function(r) {
                radarCtx.beginPath();
                radarCtx.arc(cx, cy, r * scale, 0, Math.PI * 2);
                radarCtx.stroke();
              });

              radarCtx.strokeStyle = '#334155';
              radarCtx.beginPath();
              radarCtx.moveTo(cx - 110, cy); radarCtx.lineTo(cx + 110, cy);
              radarCtx.moveTo(cx, cy - 110); radarCtx.lineTo(cx, cy + 110);
              radarCtx.stroke();

              const ents = data.entities || [];
              if (radarSummary) {
                const players = ents.filter(function(e) { return e.type === 'player'; }).length;
                const hostiles = ents.filter(function(e) { return e.type === 'hostile'; }).length;
                radarSummary.innerText = ents.length + ' entities (' + players + ' players, ' + hostiles + ' hostiles)';
              }

              ents.forEach(function(e) {
                const ex = cx + (e.dx * scale);
                const ey = cy + (e.dz * scale);
                if (Math.hypot(ex - cx, ey - cy) > 115) return;

                radarCtx.beginPath();
                if (e.type === 'player') {
                  radarCtx.fillStyle = '#38bdf8';
                  radarCtx.arc(ex, ey, 4.5, 0, Math.PI * 2);
                  radarCtx.fill();
                  radarCtx.font = '9px sans-serif';
                  radarCtx.fillStyle = '#bae6fd';
                  radarCtx.textAlign = 'center';
                  radarCtx.fillText(e.name.slice(0, 8), ex, ey - 6);
                } else if (e.type === 'hostile') {
                  radarCtx.fillStyle = '#ef4444';
                  radarCtx.arc(ex, ey, 3.5, 0, Math.PI * 2);
                  radarCtx.fill();
                } else if (e.type === 'passive') {
                  radarCtx.fillStyle = '#22c55e';
                  radarCtx.arc(ex, ey, 3, 0, Math.PI * 2);
                  radarCtx.fill();
                } else if (e.type === 'item') {
                  radarCtx.fillStyle = '#fbbf24';
                  radarCtx.arc(ex, ey, 2.5, 0, Math.PI * 2);
                  radarCtx.fill();
                }
              });

              radarCtx.beginPath();
              radarCtx.fillStyle = '#2dd4bf';
              radarCtx.arc(cx, cy, 5, 0, Math.PI * 2);
              radarCtx.fill();

              const yaw = data.yaw || 0;
              const nx = cx - Math.sin(yaw) * 14;
              const ny = cy + Math.cos(yaw) * 14;
              radarCtx.strokeStyle = '#5eead4';
              radarCtx.lineWidth = 2.5;
              radarCtx.beginPath();
              radarCtx.moveTo(cx, cy);
              radarCtx.lineTo(nx, ny);
              radarCtx.stroke();

            } catch (err) {
              if (radarSummary) radarSummary.innerText = 'Radar offline';
            }
          }

          setInterval(updateRadar, 2000);
          updateRadar();
        </script>
      </body>
    </html>
  `);
});

app.get('/tutorial', (req, res) => {

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${config.name} - Setup Guide</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #cbd5e1; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
          h1, h2 { color: #2dd4bf; }
          h1 { border-bottom: 2px solid #334155; padding-bottom: 10px; }
          .card { background: #1e293b; padding: 25px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
          a { color: #38bdf8; text-decoration: none; }
          code { background: #334155; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; font-family: monospace; }
          .btn-home { display: inline-block; margin-bottom: 20px; padding: 8px 16px; background: #334155; color: white; border-radius: 6px; text-decoration: none; }
        </style>
      </head>
      <body>
        <a href="/" class="btn-home">Back to Dashboard</a>
        <h1>Setup Guide</h1>
        <div class="card">
          <h2>Step 1: Configure Your Minecraft Server</h2>
          <ol>
            <li>Go to your server host (Aternos, Minehut, etc.).</li>
            <li>Install <strong>Paper or Bukkit</strong> software.</li>
            <li>Enable <strong>Cracked / Offline mode</strong>.</li>
            <li>Install plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code>.</li>
            <li>In <code>server.properties</code>, set <code>player-idle-timeout=0</code>.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Step 2: Configure the Bot</h2>
          <ol>
            <li>Edit <code>settings.json</code> with your server IP and port.</li>
            <li>Set your bot username and auth password.</li>
            <li>Upload all files to a GitHub repository.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Step 3: Deploy on Railway (Recommended)</h2>
          <ol>
            <li>Go to <a href="https://railway.app" target="_blank">Railway.app</a> and sign in with GitHub.</li>
            <li>Click New Project and select Deploy from GitHub repo.</li>
            <li>Railway will auto-detect Node.js and deploy.</li>
            <li>The bot will start automatically and run 24/7.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Step 4: Keep It Alive (Optional but Recommended)</h2>
          <ol>
            <li>Go to <a href="https://uptimerobot.com" target="_blank">UptimeRobot.com</a> and create a free account.</li>
            <li>Add a new HTTP monitor pointing to your Railway URL + <code>/ping</code>.</li>
            <li>Set check interval to 5 minutes.</li>
            <li>This guarantees the bot never sleeps.</li>
          </ol>
        </div>
        <p style="text-align:center;margin-top:40px;color:#64748b;">${config.name} Dashboard</p>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    serverOffline: Boolean(botState.serverOffline),
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    lastDisconnectReason: botState.serverOffline
      ? '⚠️ Server is OFFLINE. Please turn on your server! (Bot will keep reconnecting automatically)'
      : botState.lastDisconnectReason,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024
  });
});

app.get('/api/radar', (req, res) => {
  if (!bot || !botState.connected || !bot.entity) {
    return res.json({
      connected: false,
      coords: null,
      yaw: 0,
      pitch: 0,
      health: 0,
      food: 0,
      oxygen: 20,
      dimension: 'overworld',
      heldItem: null,
      hotbar: [],
      armor: { head: null, torso: null, legs: null, feet: null },
      entities: []
    });
  }

  const HOSTILE_SET = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
    'witch', 'slime', 'magma_cube', 'drowned', 'husk', 'stray', 'phantom',
    'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'warden', 'piglin_brute',
    'blaze', 'ghast', 'wither_skeleton', 'wither', 'ender_dragon', 'silverfish'
  ]);

  const botPos = bot.entity.position;
  const entities = [];
  const MAX_RADAR_DIST = 32;

  for (const entity of Object.values(bot.entities || {})) {
    if (!entity || entity === bot.entity || !entity.position) continue;
    const dx = entity.position.x - botPos.x;
    const dy = entity.position.y - botPos.y;
    const dz = entity.position.z - botPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > MAX_RADAR_DIST) continue;

    let category = 'other';
    const name = String(entity.name || entity.username || '').toLowerCase();
    if (entity.type === 'player' || entity.username) {
      category = 'player';
    } else if (HOSTILE_SET.has(name) || entity.type === 'hostile' || entity.type === 'mob') {
      category = HOSTILE_SET.has(name) ? 'hostile' : 'passive';
    } else if (entity.type === 'animal') {
      category = 'passive';
    } else if (entity.name === 'item' || entity.type === 'item' || entity.type === 'object') {
      category = 'item';
    }

    entities.push({
      id: entity.id,
      name: entity.username || entity.name || 'unknown',
      type: category,
      dx: Math.round(dx * 10) / 10,
      dy: Math.round(dy * 10) / 10,
      dz: Math.round(dz * 10) / 10,
      distance: Math.round(dist * 10) / 10
    });
  }

  const hotbar = [];
  const quickBarSlot = bot.quickBarSlot || 0;
  for (let i = 0; i < 9; i++) {
    const item = bot.inventory?.slots ? bot.inventory.slots[36 + i] : null;
    hotbar.push({
      slot: i,
      selected: i === quickBarSlot,
      name: item?.name || null,
      displayName: item?.displayName || (item?.name ? item.name.replace(/_/g, ' ') : 'Empty'),
      count: item?.count || 0
    });
  }

  const getSlotItem = (s) => {
    const it = bot.inventory?.slots ? bot.inventory.slots[s] : null;
    return it ? { name: it.name, count: it.count } : null;
  };

  res.json({
    connected: true,
    coords: {
      x: Math.round(botPos.x * 10) / 10,
      y: Math.round(botPos.y * 10) / 10,
      z: Math.round(botPos.z * 10) / 10
    },
    yaw: bot.entity.yaw || 0,
    pitch: bot.entity.pitch || 0,
    health: bot.health != null ? bot.health : 20,
    food: bot.food != null ? bot.food : 20,
    oxygen: bot.oxygenLevel != null ? bot.oxygenLevel : 20,
    dimension: bot.game?.dimension || 'overworld',
    heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
    hotbar,
    armor: {
      head: getSlotItem(5),
      torso: getSlotItem(6),
      legs: getSlotItem(7),
      feet: getSlotItem(8)
    },
    entities
  });
});

app.post('/api/discord/chat', (req, res) => {
  const secretProvided = req.headers['x-discord-token'] || req.body?.token;
  const configuredSecret = process.env.DISCORD_RELAY_TOKEN || config.discord?.relaySecret;

  if (configuredSecret && secretProvided !== configuredSecret) {
    if (!hasDashboardAccess(req)) {
      return res.status(401).json({ error: 'Unauthorized: invalid Discord relay token.' });
    }
  }

  const username = String(req.body?.username || 'DiscordUser').trim().slice(0, 32);
  const message = String(req.body?.message || '').trim().slice(0, 256);

  if (!message) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  if (!bot || !botState.connected) {
    return res.status(503).json({ error: 'Bot is currently not connected to the Minecraft server.' });
  }

  try {
    bot.chat('[Discord] <' + username + '> ' + message);

    if (/^[!/]ai\b/i.test(message)) {
      const commandText = message.replace(/^[!/]ai\s*/i, '').trim();
      const aiAllowedUsers = getAIChatAllowedUsers(config.ai);
      if (config.ai?.enabled && isAIChatAuthorized(username, aiAllowedUsers)) {
        aiAgent.start(commandText, username);
      }
    }

    res.json({ success: true, message: 'Message relayed to in-game chat.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent/status', (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  res.json(aiAgent.getStatus());
});

app.post('/api/control/input', (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  if (!botState.connected || !bot) {
    return res.status(503).json({ error: 'The Minecraft bot is not connected yet.' });
  }
  if (['working', 'paused'].includes(aiAgent.getStatus().status)) {
    return res.status(409).json({ error: 'Stop the active AI instruction before using manual controls.' });
  }
  try {
    const active = manualControlSession.set(req.body?.input, req.body?.pressed);
    res.json({ active, message: active.length ? `Holding: ${active.join(', ')}` : 'Patrol will resume.' });
  } catch (error) {
    const status = error instanceof TypeError ? 400 : 500;
    res.status(status).json({ error: error.message });
  }
});

app.post('/api/control/action', async (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  if (!botState.connected || !bot) {
    return res.status(503).json({ error: 'The Minecraft bot is not connected yet.' });
  }
  try {
    const result = await manualControlSession.performAction(req.body?.action, req.body?.payload);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/control/release', (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  try {
    manualControlSession.release();
    res.json({ active: [], message: 'All movement keys released.' });
  } catch (error) {
    res.status(500).json({ error: `Could not release movement keys: ${error.message}` });
  }
});

app.post('/api/control/heartbeat', (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  if (!botState.connected || !bot) {
    return res.status(503).json({ error: 'The Minecraft bot is not connected yet.' });
  }
  try {
    res.json({ active: manualControlSession.heartbeat() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/instruction', (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  if (!botState.connected) {
    return res.status(503).json({ error: 'The Minecraft bot is not connected yet.' });
  }
  try {
    res.status(202).json(aiAgent.start(req.body?.instruction));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/agent/stop', (req, res) => {
  if (!hasDashboardAccess(req)) {
    return res.status(process.env.DASHBOARD_TOKEN ? 401 : 503)
      .json({ error: 'A valid DASHBOARD_TOKEN is required.' });
  }
  res.json(aiAgent.stop());
});

app.get('/ping', (req, res) => res.send('pong'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] HTTP server started on port ${server.address().port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const fallbackPort = PORT + 1;
    console.log(`[Server] Port ${PORT} in use - trying port ${fallbackPort}`);
    app.listen(fallbackPort, '0.0.0.0', () => {
      console.log(`[Server] HTTP server started on fallback port ${fallbackPort}`);
    });
  } else {
    console.log(`[Server] HTTP server error: ${err.message}`);
  }
});

const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const hostUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL;
  if (!hostUrl) {
    console.log('[KeepAlive] No host URL env var set - self-ping disabled (running locally)');
    return;
  }
  setInterval(() => {
    const protocol = hostUrl.startsWith('https') ? https : http;

    protocol.get(`${hostUrl}/ping`, (res) => {
      res.resume();
    }).on('error', (err) => {
      console.log(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);
  console.log('[KeepAlive] Self-ping started (every 10 min)');
}

startSelfPing();

setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[Memory] Heap: ${heapMB} MB`);
}, 5 * 60 * 1000);

function clearBotTimeouts() {
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
}

function clearBlockAtGuard() {
  if (blockAtGuardTimer) {
    clearInterval(blockAtGuardTimer);
    blockAtGuardTimer = null;
  }
}

let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000;

function clearAllIntervals() {
  console.log(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function formatKickReason(raw) {
  if (!raw) return 'Unknown reason';
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return formatKickReason(parsed);
    } catch {
      return raw.replace(/§[0-9a-fk-or]/gi, '').trim();
    }
  }
  if (typeof raw === 'object') {
    if (raw.type === 'compound' && raw.value) {
      return formatKickReason(raw.value);
    }
    if (raw.translate) {
      const transKey = typeof raw.translate === 'object' ? (raw.translate.value || raw.translate.text || JSON.stringify(raw.translate)) : raw.translate;
      if (transKey === 'disconnect.spam') return 'Kicked for spamming (too many messages/commands sent too quickly)';
      if (transKey === 'disconnect.timeout') return 'Connection timed out';
      if (transKey === 'disconnect.kicked') return 'Kicked by operator or server plugin';
      if (transKey === 'disconnect.loginFailedInfo') return 'Login failed';
      return String(transKey);
    }
    let result = '';
    if (raw.text) {
      result += typeof raw.text === 'object' ? (raw.text.value || '') : raw.text;
    }
    if (Array.isArray(raw.extra)) {
      result += raw.extra.map(item => (typeof item === 'object' ? formatKickReason(item) : String(item))).join('');
    }
    const clean = result.replace(/§[0-9a-fk-or]/gi, '').trim();
    return clean || JSON.stringify(raw);
  }
  return String(raw);
}

function isDuplicateLoginReason(reason) {
  const text = String(reason || '').toLowerCase();
  return text.includes('duplicate_login') ||
    text.includes('another location') ||
    text.includes('already connected') ||
    text.includes('already logged in') ||
    text.includes('logged in from another');
}

function isServerOfflineError(reason) {
  const text = String(reason?.message || reason?.code || reason || '').toLowerCase();
  return (
    text.includes('econnrefused') ||
    text.includes('connect econnrefused') ||
    text.includes('econnreset') ||
    text.includes('write econnreset') ||
    text.includes('socketclosed') ||
    text.includes('socket closed') ||
    text.includes('enotfound') ||
    text.includes('etimedout') ||
    text.includes('ehostunreach') ||
    text.includes('ehostdown') ||
    text.includes('enetunreach') ||
    text.includes('connection refused') ||
    text.includes('no spawn received') ||
    text.includes('server offline') ||
    text.includes('timed out') ||
    text.includes('could not connect') ||
    text.includes('failed to ping')
  );
}

function getReconnectDelay() {
  if (botState.duplicateLogin) {
    botState.duplicateLogin = false;
    const duplicateDelay = Number(config.utils['duplicate-login-delay']) || 300000;
    const jitter = Math.floor(Math.random() * 5000);
    console.log(
      `[Bot] Duplicate login detected - another client is using this username. ` +
      `Waiting ${Math.round((duplicateDelay + jitter) / 1000)}s before reconnecting.`
    );
    return duplicateDelay + jitter;
  }
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    console.log(`[Bot] Throttle detected - extended delay: ${throttleDelay / 1000}s`);
    return throttleDelay;
  }
  const baseDelay = config.utils['auto-reconnect-delay'] || 3000;
  const maxDelay = config.utils['max-reconnect-delay'] || 30000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

function createBot() {
  if (isReconnecting) {
    console.log('[Bot] Already reconnecting, skipping...');
    return;
  }

  clearBlockAtGuard();

  if (bot) {
    clearAllIntervals();
    try {
      manualControlSession.release();
    } catch (error) {
      console.log(`[Controls] Could not release inputs before reconnect: ${error.message}`);
      manualControlSession.disconnect();
    }
    try { bot.removeAllListeners(); bot.end(); } catch (e) {
      console.log('[Cleanup] Error ending previous bot:', e.message);
    }
    bot = null;
  }

  try {
    const resolvedPort = (config.server.port && Number(config.server.port) !== 25565)
      ? Number(config.server.port)
      : undefined;

    console.log(`[Bot] Connecting to ${config.server.ip}${resolvedPort ? `:${resolvedPort}` : ' (auto-resolving SRV port)'}`);

    const versionResolution = resolveBotVersion(config);
    const botVersion = versionResolution.version;
    if (versionResolution.fallback) {
      console.warn(
        `[Compatibility] Native Minecraft ${versionResolution.requested} is unavailable; ` +
        `using client ${botVersion}. The server must provide ViaVersion or ViaProxy.`
      );
    }

    const botUsername = process.env.BOT_USERNAME || config['bot-account'].username;
    const botPassword = process.env.BOT_PASSWORD || config['bot-account'].password || undefined;
    const authPassword = process.env.BOT_AUTH_PASSWORD || config.utils['auto-auth']?.password;

    bot = mineflayer.createBot({
      username: botUsername,
      password: botPassword,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: resolvedPort,
      version: botVersion,
      hideErrors: true,
      respawn: true,
      checkTimeoutInterval: 600000
    });
    const patchBotChat = () => {
      if (!bot || typeof bot.chat !== 'function' || bot._rawChat) return;
      const originalChat = bot.chat.bind(bot);
      bot._rawChat = originalChat;
      bot.chat = (msg) => enqueueSafeChat(msg, originalChat);
    };
    if (bot._client?.write) {
      bot.once('inject_allowed', patchBotChat);
      setTimeout(patchBotChat, 3000);
    } else {
      patchBotChat();
    }
    installProtocolPacketCompatibility(bot);

    blockAtGuardTimer = setInterval(() => {
      if (!bot || typeof bot.blockAt !== 'function') return;
      const guardedBot = bot;
      const blockAt = guardedBot.blockAt.bind(guardedBot);
      guardedBot.blockAt = position => guardedBot.world ? blockAt(position) : null;
      clearBlockAtGuard();
    }, 10);
    bot.once('spawn', clearBlockAtGuard);

    // minecraft-protocol responds to select_known_packs only after the server
    // sends that request. Do not synthesize an early reply when seeing brand.

    bot.loadPlugin(pathfinder);

    clearBotTimeouts();
    const connectingBot = bot;
    connectionTimeoutId = setTimeout(() => {
      if (bot === connectingBot && !botState.connected) {
        botState.serverOffline = true;
        botState.lastDisconnectReason = 'Server did not respond (offline). Please turn on your server!';
        console.warn(`[Bot] ⚠️ WARNING: Server (${config.server.ip}:${config.server.port}) did not respond and appears to be OFFLINE. Please turn on your server! Virgo will keep reconnecting.`);
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (error) {
          console.log(`[Bot] Connection timeout cleanup failed: ${error.message}`);
        }
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;
    let connectedAt = 0;
    let kickedReason = null;
    let deathRecoveryScheduled = false;

    bot.once('spawn', () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.serverOffline = false;
      botState.lastActivity = Date.now();
      connectedAt = Date.now();
      isReconnecting = false;

      console.log(`[Bot] Spawned on server (version: ${bot.version})`);
      pluginLoader.onBotReady(bot);

      if (config.discord?.events?.connect) {
        sendDiscordWebhook(`Connected to \`${config.server.ip}\``, 0x4ade80);
      }

      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = true;
      defaultMove.digCost = 15;
      defaultMove.maxDropDown = 4;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(bot, mcData, defaultMove, authPassword);

      let mlgClutchActive = false;
      bot.on('physicsTick', async () => {
        if (!bot || !bot.entity || mlgClutchActive) return;
        const velY = bot.entity.velocity ? bot.entity.velocity.y : 0;
        if (velY < -0.65 && !bot.entity.isInWater && !bot.entity.isInLava) {
          const inv = bot.inventory?.items ? bot.inventory.items() : [];
          const waterBucket = inv.find(it => it.name === 'water_bucket');
          if (waterBucket) {
            const feetPos = bot.entity.position;
            const ground = bot.blockAt ? bot.blockAt(feetPos.offset(0, -1, 0)) : null;
            if (ground && ground.boundingBox === 'block' && ground.name !== 'air') {
              mlgClutchActive = true;
              try {
                if (typeof bot.equip === 'function') await bot.equip(waterBucket, 'hand');
                if (typeof bot.look === 'function') await bot.look(bot.entity.yaw, -Math.PI / 2, true);
                if (typeof bot.activateItem === 'function') bot.activateItem();
                setTimeout(() => {
                  try {
                    if (typeof bot.activateItem === 'function') bot.activateItem();
                  } catch {}
                  mlgClutchActive = false;
                }, 400);
              } catch {
                mlgClutchActive = false;
              }
            }
          }
        }
      });

      setTimeout(() => {
        if (bot && botState.connected && !config.ai?.enabled && config.server['try-creative']) {
          bot.chat('/gamemode creative');
          console.log('[INFO] Attempted creative mode (requires OP)');
        }
      }, 3000);

      bot.on('messagestr', (message) => {
        if (
          message.includes('commands.gamemode.success.self') ||
          message.includes('Set own game mode to Creative Mode')
        ) {
          console.log('[INFO] Bot is now in Creative Mode.');
        }
      });
    });

    bot.on('death', () => {
      if (aiAgent.recordDeath()) console.log('[AI] Recorded the bot death location for safe item recovery.');
      if (['working', 'paused'].includes(aiAgent.getStatus().status)) aiAgent.stop();
    });

    const scheduleDeathRecovery = () => {
      if (!config.ai?.enabled || !aiAgent.hasDeathRecovery() || deathRecoveryScheduled) return;
      deathRecoveryScheduled = true;
      setTimeout(() => {
        deathRecoveryScheduled = false;
        if (bot !== connectingBot || !botState.connected || !aiAgent.hasDeathRecovery()) return;
        void aiAgent.recoverDroppedItems().then(result => {
          console.log(`[AI] Death recovery: ${result.message}`);
        }).catch(error => {
          console.log(`[AI] Death recovery paused: ${error.message}`);
        });
      }, 5000);
    };
    bot.on('spawn', scheduleDeathRecovery);
    bot.on('respawn', scheduleDeathRecovery);

    bot.on('kicked', (reason) => {
      const readableKick = formatKickReason(reason);
      kickedReason = readableKick;
      console.log(`[Bot] 🚨 Kicked from server: "${readableKick}"`);
      botState.connected = false;
      manualControlSession.disconnect();
      botState.lastDisconnectReason = readableKick;
      pushError({ type: 'kicked', reason: readableKick, time: Date.now() });
      chatQueue.length = 0;
      clearAllIntervals();
      clearBlockAtGuard();

      const reasonStr = String(readableKick).toLowerCase();
      if (reasonStr.includes('spam')) {
        console.log('[Bot] ⚠️ Anti-spam kick detected — cleared outgoing chat queue and throttled commands.');
        botState.wasThrottled = true;
      }
      if (reasonStr.includes('throttl') || reasonStr.includes('wait before reconnect') || reasonStr.includes('too fast')) {
        console.log('[Bot] Throttle kick detected');
        botState.wasThrottled = true;
      }

      if (isDuplicateLoginReason(readableKick)) {
        console.log('[Bot] Another client is using this username - backing off before reconnecting');
        botState.duplicateLogin = true;
      }

      if (config.discord?.events?.disconnect) {
        sendDiscordWebhook(`Kicked: ${readableKick}`, 0xff0000);
      }
      scheduleReconnect();
    });

    bot.on('end', (reason) => {
      chatQueue.length = 0;
      const disconnectReason = kickedReason || formatKickReason(reason);
      console.log(`[Bot] Disconnected: ${disconnectReason}`);
      pluginLoader.onBotEnd(bot);
      botState.connected = false;
      manualControlSession.disconnect();
      botState.lastDisconnectReason = disconnectReason;
      if (isServerOfflineError(disconnectReason)) {
        botState.serverOffline = true;
        console.warn(`[Bot] ⚠️ WARNING: Minecraft server (${config.server.ip}:${config.server.port}) is OFFLINE! Please turn on the server. Continuing to reconnect in the background...`);
      }
      if (connectedAt && Date.now() - connectedAt >= 60000) botState.reconnectAttempts = 0;
      connectedAt = 0;
      clearAllIntervals();
      clearBlockAtGuard();
      spawnHandled = false;

      if (isDuplicateLoginReason(disconnectReason)) {
        botState.duplicateLogin = true;
      }

      if (config.discord?.events?.disconnect) {
        sendDiscordWebhook(`Disconnected: ${disconnectReason}`, 0xf87171);
      }

      scheduleReconnect();
    });

    bot.on('error', (err) => {
      const protocolState = bot?._client?.state || 'unknown';
      const protocolVersion = bot?.version || 'unknown';
      console.log(`[Bot] Error (version=${protocolVersion}, state=${protocolState}): ${err.message}`);
      pushError({ type: 'error', message: err.message, time: Date.now() });
      if (isServerOfflineError(err)) {
        botState.serverOffline = true;
        botState.lastDisconnectReason = 'Minecraft server is offline. Please turn on your server!';
        console.warn(`[Bot] ⚠️ WARNING: Minecraft server (${config.server.ip}:${config.server.port}) is OFFLINE! Please turn on the server. Continuing to reconnect in the background...`);
      }
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    if (isServerOfflineError(err)) {
      botState.serverOffline = true;
      console.warn(`[Bot] ⚠️ WARNING: Minecraft server (${config.server.ip}:${config.server.port}) is OFFLINE! Please turn on the server. Continuing reconnect loop...`);
    }
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (isReconnecting) {
    console.log('[Bot] Reconnect already scheduled, skipping duplicate.');
    return;
  }

  if (config.utils['auto-reconnect'] === false) {
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
    console.log('[Bot] Auto-reconnect is disabled in settings.');
    return;
  }

  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  if (botState.serverOffline) {
    console.log(`[Bot] ⚠️ Server is offline — waiting ${Math.round(delay / 1000)}s before reconnect attempt #${botState.reconnectAttempts} (will keep retrying until server starts)...`);
  } else {
    console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);
  }

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

function attachRecentAIEvents(bot) {
  if (!bot || bot.aiRecentEvents) return;
  const events = [];
  bot.aiRecentEvents = events;
  const record = (type, detail = '') => {
    events.push({ type, detail: String(detail || '').slice(0, 80), at: Date.now() });
    if (events.length > 16) events.splice(0, events.length - 16);
  };
  let previousHealth = Number(bot.health);
  bot.on('death', () => record('death', 'Died; recovery may be available.'));
  bot.on('health', () => {
    const health = Number(bot.health);
    if (Number.isFinite(health) && Number.isFinite(previousHealth) && health <= previousHealth - 2) {
      record('damage', `Health fell to ${health}/20.`);
    }
    previousHealth = health;
  });
  bot.on('entityHurt', entity => {
    if (entity && entity === bot.entity) record('hurt', 'The bot was hit.');
  });
  bot.on('weatherUpdate', () => record('weather', bot.isRaining ? 'Rain started or intensified.' : 'Rain stopped or weakened.'));
  bot.on('playerJoined', player => record('player_joined', player?.username || player?.displayName || 'A player joined.'));
  bot.on('playerLeft', player => record('player_left', player?.username || player?.displayName || 'A player left.'));
}

function initializeModules(bot, mcData, defaultMove, authPassword) {
  attachRecentAIEvents(bot);
  console.log('[Modules] Initializing...');

  if (config.ai?.enabled || config.modules.chat) chatModule(bot);
  const aiAllowedUsers = getAIChatAllowedUsers(config.ai, config.chat);
  if (config.ai?.enabled) {
    console.log(`[AI Chat] Commands enabled; trusted users: ${aiAllowedUsers.join(', ') || '(none configured)'}.`);
  } else {
    console.log('[AI Chat] AI commands disabled; set ai.enabled=true in settings.json.');
  }
  if (config.ai?.enabled && config.ai.learnFromAllowlistedChat && config.ai.memory !== false) {
    console.log('[AI] Local chat learning is enabled for configured AI chat users.');
  }

  if (config.utils['auto-auth']?.enabled && authPassword) {
    const MAX_AUTH_ATTEMPTS = 2;
    const AUTH_RETRY_COOLDOWN_MS = 6000;
    let authCompleted = false;
    let authAttempts = 0;
    let lastAttemptAt = 0;
    let lastPromptText = '';
    let lastPromptAt = 0;

    const IGNORED = /unknown command|did you mean|usage:|incorrect usage|invalid usage|command not found/i;
    const REGISTER_PROMPT = /please register|not registered|register with \/register|\/register <password>|register <password>/i;
    const LOGIN_PROMPT = /please login|not logged in|already registered|login with \/login|\/login <password>|login <password>/i;
    const SUCCESS = /successfully|logged in|welcome back|registration complete|registered successfully|성공/i;
    const WRONG_PASSWORD = /wrong password|incorrect password|invalid password|비밀번호/i;

    const canSend = () => {
      if (authCompleted || authAttempts >= MAX_AUTH_ATTEMPTS) return false;
      if (!bot || !botState.connected) return false;
      if (Date.now() - lastAttemptAt < AUTH_RETRY_COOLDOWN_MS) return false;
      return true;
    };

    const handleAuthMessage = (rawText) => {
      if (authCompleted || !bot || !botState.connected) return;
      const clean = String(rawText || '').replace(/§[0-9a-fk-or]/gi, '').trim();
      if (!clean || IGNORED.test(clean)) {
        if (IGNORED.test(clean)) {
          authCompleted = true;
          console.log('[Auth] Server has no auth prompt; treating the account as authenticated.');
        }
        return;
      }
      const now = Date.now();
      if (clean === lastPromptText && now - lastPromptAt < 15000) return;
      lastPromptAt = now;
      lastPromptText = clean;

      if (SUCCESS.test(clean)) {
        authCompleted = true;
        console.log('[Auth] Successfully authenticated!');
        return;
      }
      if (WRONG_PASSWORD.test(clean)) {
        console.error(`[Auth] Server reported a password problem for "${authPassword}"! Check settings.json.`);
        return;
      }
      const wantsRegister = REGISTER_PROMPT.test(clean);
      const wantsLogin = LOGIN_PROMPT.test(clean);
      if (!wantsRegister && !wantsLogin) return;
      if (!canSend()) return;
      authAttempts += 1;
      lastAttemptAt = now;
      if (wantsRegister && config.utils['auto-auth']?.register) {
        bot.chat(`/register ${authPassword} ${authPassword}`);
        console.log(`[Auth] Sent /register (attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS})`);
      } else {
        bot.chat(`/login ${authPassword}`);
        console.log(`[Auth] Sent /login (attempt ${authAttempts}/${MAX_AUTH_ATTEMPTS})`);
      }
    };

    bot.on('messagestr', handleAuthMessage);
    bot.on('actionBar', (msg) => {
      const text = typeof msg?.getText === 'function' ? msg.getText() : String(msg?.text || msg || '');
      handleAuthMessage(text);
    });
    bot.on('title', (text) => handleAuthMessage(text));

    setTimeout(() => {
      if (authCompleted || !bot || !botState.connected) return;
      if (authAttempts > 0) return;
      console.log('[Auth] No auth prompt seen; not sending anything until the server asks.');
    }, 3000);
  }

  if (config.ai?.enabled) {
    bot.pathfinder.setMovements(defaultMove);
    addInterval(() => aiAgent.checkSurvival(), Number(config.ai?.survivalIntervalMs) || 4000);
    if (config.ai.autonomous?.enabled) {
      try {
        aiAgent.startAutonomous();
        console.log('[AI] Autonomous bounded gathering started.');
      } catch (error) {
        console.error(`[AI] Could not start autonomous gathering: ${error.message}`);
      }
    }
    console.log('[AI] AI mode enabled; user tasks, safe hostile-mob defense, and death recovery are active.');
  }

  if (config.utils['chat-messages']?.enabled) {
    const messages = config.utils['chat-messages'].messages;
    if (config.utils['chat-messages'].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils['chat-messages']['repeat-delay'] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => { if (bot && botState.connected) bot.chat(msg); }, idx * 1000);
      });
    }
  }

  if (config.position?.enabled && !(config.movement?.['circle-walk']?.enabled) && !config.ai?.enabled) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    console.log('[Position] Navigating to configured position...');
  }

  if (config.utils['anti-afk']?.enabled) {
    const isBotBusy = () => {
      if (!bot || !botState.connected || manualControls.size) return true;
      if (config.ai?.enabled && ['working'].includes(aiAgent.getStatus().status)) return true;
      return false;
    };

    addInterval(() => {
      if (isBotBusy()) return;
      try { bot.swingArm(); } catch (e) { }
    }, 10000 + Math.floor(Math.random() * 50000));

    addInterval(() => {
      if (isBotBusy()) return;
      try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (e) { }
    }, 30000 + Math.floor(Math.random() * 90000));

    addInterval(() => {
      if (isBotBusy() || typeof bot.setControlState !== 'function') return;
      if (Math.random() > 0.9) {
        let count = 2 + Math.floor(Math.random() * 4);
        const doTeabag = () => {
          if (count <= 0 || !bot || typeof bot.setControlState !== 'function') return;
          try {
            bot.setControlState('sneak', true);
            setTimeout(() => {
              if (bot && typeof bot.setControlState === 'function') bot.setControlState('sneak', false);
              count--;
              setTimeout(doTeabag, 150);
            }, 150);
          } catch (e) { }
        };
        doTeabag();
      }
    }, 120000 + Math.floor(Math.random() * 180000));

    if (!(config.movement?.['circle-walk']?.enabled)) {
      addInterval(() => {
        if (isBotBusy() || typeof bot.setControlState !== 'function') return;
        try {
          bot.look(Math.random() * Math.PI * 2, 0, true);
          bot.setControlState('forward', true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === 'function') bot.setControlState('forward', false);
          }, 500 + Math.floor(Math.random() * 1500));
          botState.lastActivity = Date.now();
        } catch (e) {
          console.log('[AntiAFK] Walk error:', e.message);
        }
      }, 120000 + Math.floor(Math.random() * 360000));
    }

    if (config.utils['anti-afk'].sneak) {
      try {
        if (typeof bot.setControlState === 'function') bot.setControlState('sneak', true);
      } catch (e) { }
    }
  }

  if (config.movement?.enabled !== false) {
    if (isPatrolEnabled(config)) {
      startCircleWalk(bot, defaultMove);
    }

    if (config.movement?.['random-jump']?.enabled && !(config.movement?.['circle-walk']?.enabled)) {
      startRandomJump(bot);
    }
    if (config.movement?.['look-around']?.enabled) {
      startLookAround(bot);
    }
  }

  if (config.modules.avoidMobs && !config.modules.combat) {
    avoidMobs(bot);
  }
  if (config.modules.combat) {
    combatModule(bot, mcData);
  }
  if (config.modules.beds) {
    bedModule(bot, mcData);
  }
  if (config.utils['chat-log'] || config.ai?.enabled) {
    bot.on('chat', (username, message) => {
      if (username !== bot.username) {
        console.log(`[Chat] <${username}> ${message}`);
      }
    });
  }

  if (config.modules['console-commands']) {
    setupConsoleCommands();
  }

  console.log('[Modules] All modules initialized.');
}

function setupConsoleCommands() {
  if (consoleCommandsInitialized) return;
  consoleCommandsInitialized = true;

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    if (!bot || !botState.connected) { console.log('[Console] Bot not connected'); return; }
    const trimmed = line.trim();
    if (trimmed.startsWith('say ')) {
      bot.chat(trimmed.slice(4));
    } else if (trimmed.startsWith('cmd ')) {
      bot.chat('/' + trimmed.slice(4));
    } else if (trimmed === 'status') {
      console.log(`Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`);
    } else {
      bot.chat(trimmed);
    }
  });
}

function startCircleWalk(currentBot, defaultMove) {
  if (!isPatrolEnabled(config)) return;
  const patrolBot = currentBot;
  const anchor = patrolBot.entity.position.floored();
  const settings = config.movement['circle-walk'];
  const interval = Math.max(500, Number(settings.speed) || 3000);
  let stopped = false;

  patrolBot.once('end', () => { stopped = true; });
  patrolBot.pathfinder.setMovements(defaultMove);

  runPatrol({
    anchor,
    radius: settings.radius,
    interval,
    shouldStop: () => stopped || bot !== patrolBot || !botState.connected,
    shouldPause: () => manualControls.size > 0 ||
      (config.ai?.enabled && ['working', 'paused'].includes(aiAgent.getStatus().status)),
    goto: point => patrolBot.pathfinder.goto(new GoalNearXZ(point.x, point.z, 2)),
    onError: (error, point) => {
      console.log(`[Patrol] Could not reach waypoint (${point.x}, ${point.y}, ${point.z}): ${error.message}`);
    }
  }).catch(error => {
    if (!stopped) console.log('[Patrol] Error:', error.message);
  });
}

function startRandomJump(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || manualControls.size || typeof bot.setControlState !== 'function') return;
    if (config.ai?.enabled && ['working', 'paused'].includes(aiAgent.getStatus().status)) return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (bot && !manualControls.has('jump') && typeof bot.setControlState === 'function') {
          bot.setControlState('jump', false);
        }
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      console.log('[RandomJump] Error:', e.message);
    }
  }, config.movement['random-jump'].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || manualControls.size) return;
    if (config.ai?.enabled && ['working', 'paused'].includes(aiAgent.getStatus().status)) return;
    try {
      const yaw = (Math.random() * Math.PI * 2) - Math.PI;
      const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      console.log('[LookAround] Error:', e.message);
    }
  }, config.movement['look-around'].interval);
}

function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected || manualControls.size || typeof bot.setControlState !== 'function') return;
    try {
      const entities = Object.values(bot.entities).filter(e =>
        e.type === 'mob' || (e.type === 'player' && e.username !== bot.username)
      );
      for (const e of entities) {
        if (!e.position) continue;
        if (bot.entity.position.distanceTo(e.position) < safeDistance) {
          bot.setControlState('back', true);
          setTimeout(() => {
            if (bot && !manualControls.has('back') && typeof bot.setControlState === 'function') {
              bot.setControlState('back', false);
            }
          }, 500);
          break;
        }
      }
    } catch (e) {
      console.log('[AvoidMobs] Error:', e.message);
    }
  }, 2000);
}

function combatModule(bot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  bot.on('physicsTick', () => {
    if (!bot || !botState.connected || manualControls.size || !config.combat['attack-mobs']) return;
    const now = Date.now();
    if (now - lastAttackTime < 620) return;

    try {

      if (lockedTarget && now < lockedTargetExpiry && bot.entities[lockedTarget.id] && lockedTarget.position) {
        if (bot.entity.position.distanceTo(lockedTarget.position) < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        } else {
          lockedTarget = null;
        }
      }

      const mobs = Object.values(bot.entities).filter(e =>
        e.type === 'mob' && e.position && bot.entity.position.distanceTo(e.position) < 4
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000;
        bot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      console.log('[Combat] Error:', e.message);
    }
  });

  bot.on('health', () => {
    if (!config.combat['auto-eat']) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find(i => {
          const foodData = mcData.foods ? Object.values(mcData.foods).find(f => f.id === i.type) : null;
          return foodData && foodData.foodPoints > 0;
        });
        if (food) {

          bot.equip(food, 'hand')
            .then(() => {
              if (bot && botState.connected) return bot.consume();
            })
            .catch(e => console.log('[AutoEat] Error:', e.message));
        }
      }
    } catch (e) {
      console.log('[AutoEat] Error:', e.message);
    }
  });
}

function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected || !config.beds['place-night']) return;

    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;
      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: block => block.name.includes('bed'),
          maxDistance: 8
        });
        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock);
            console.log('[Bed] Sleeping...');
          } catch (e) {

          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      console.log('[Bed] Error:', e.message);
    }
  }, 10000);
}

function chatModule(bot) {

  const aiAllowedUsers = getAIChatAllowedUsers(config.ai, config.chat);
  const lastAutoResponseAt = new Map();

  bot.on('chat', (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      const aiCommand = parseAIChatCommand(message);
      if (config.ai?.enabled && config.ai.memory !== false && config.ai.learnFromAllowlistedChat) {
        const note = createTrustedChatMemoryNote(username, message, aiAllowedUsers);
        if (note && aiCommand?.type !== 'teach') {
          try {
            aiAgent.addMemoryNote(note);
          } catch (error) {
            console.error(`[AI] Could not save trusted chat memory: ${error.message}`);
          }
        }
      }

      if (aiCommand) {
        if (!config.ai?.enabled) {
          sendAIChatMessage('AI mode is disabled on this server. Set ai.enabled to true in settings.json.');
          return;
        }
        if (!isAIChatAuthorized(username, aiAllowedUsers)) {
          console.log(`[AI Chat] Ignored command from untrusted user: ${username}`);
          return;
        }
        try {
          if (aiCommand.type === 'help') {
            sendAIChatMessage('Use !ai <task>, !ai recognize, !ai research <topic>, !ai knowledge [query], !ai train, !ai train status, !ai stop training, !ai skills <search>, !ai skill <id> [count], !ai think <goal>, !ai solve <goal>, !ai brain, !ai why, !ai teach <rule>, !ai memory, !ai forget <text>, !ai status, !ai pause, !ai resume, !ai plugins, !ai vision, or !ai stop.');
          } else if (aiCommand.type === 'status') {
            const status = aiAgent.getStatus();
            const grinding = aiAgent.autonomyActive ? 'Autonomous gathering is enabled.' : 'Autonomous gathering is paused.';
            sendAIChatMessage(`${status.status}: ${status.message} ${grinding}`);
          } else if (aiCommand.type === 'stop') {
            aiAgent.stop();
          } else if (aiCommand.type === 'pause') {
            const result = aiAgent.pauseAutonomous();
            sendAIChatMessage(result.paused ? 'Autonomous gathering paused.' : 'Autonomous gathering was not active.');
          } else if (aiCommand.type === 'resume') {
            aiAgent.startAutonomous();
            sendAIChatMessage('Autonomous gathering resumed. Send another !ai task to pause it for your command.');
          } else if (aiCommand.type === 'teach') {
            aiAgent.addMemoryNote(aiCommand.text);
            sendAIChatMessage('Saved that local play note for future tasks.');
          } else if (aiCommand.type === 'recover') {
            if (['working', 'paused'].includes(aiAgent.getStatus().status)) {
              throw new Error('Stop the current task before recovering items.');
            }
            void aiAgent.recoverDroppedItems().then(result => {
              sendAIChatMessage(result.message);
            }).catch(error => {
              sendAIChatMessage(`Recovery paused: ${error.message}`);
            });
          } else if (aiCommand.type === 'plugins') {
            const sub = (aiCommand.text || '').toLowerCase();
            if (sub === 'reload') {
              const r = pluginLoader.reload();
              sendAIChatMessage(`Plugins reloaded. Before: ${r.before}. After: ${r.after}.`);
            } else {
              const list = pluginLoader.list();
              if (!list.length) {
                sendAIChatMessage('No plugins loaded. Drop .js files in the plugins/ folder, then say !ai plugins reload.');
              } else {
                sendAIChatMessage(`Plugins (${list.length}): ${list.map(p => p.name + (p.commands.length ? ' [!' + p.commands.join(', !') + ']' : '')).join(', ')}. Say !ai plugins reload to rescan.`);
              }
            }
          } else if (aiCommand.type === 'vision') {
            const sub = (aiCommand.text || '').toLowerCase();
            if (sub === 'on') {
              if (!visionController) visionController = createVisionController();
              if (visionController) { visionController.start(); sendAIChatMessage('Vision control on.'); }
              else sendAIChatMessage('Could not start vision control.');
            } else if (sub === 'off') {
              if (visionController) { visionController.stop(); sendAIChatMessage('Vision control off.'); }
              else sendAIChatMessage('Vision control was not running.');
            } else {
              const st = visionController ? visionController.status() : { enabled: false };
              sendAIChatMessage(`Vision control ${st.enabled ? 'ON' : 'off'} (model ${st.model || '?'}, ticks ${st.ticks || 0}, last ${st.lastAction || 'none'}). Say !ai vision on/off.`);
            }
          } else if (aiCommand.type === 'sygget') {
            const syggetTask = (aiCommand.text || '').trim();
            const target = syggetTask && !/^(?:me|set me|make me)$/i.test(syggetTask)
              ? syggetTask
              : AUTONOMOUS_INSTRUCTION;
            aiAgent.start(target, username);
            sendAIChatMessage(`${username}: Sygget engaged — working on that now. Use !ai status to check progress.`);
          } else {
            const isQuestion = /\?$/.test(aiCommand.text) ||
              /^(?:who|what|how|why|when|where|which|can|could|would|will|is|are|does|do|did|tell|joke|calc|calculate|recipe|status|help)\b/i.test(aiCommand.text);
            aiAgent.start(aiCommand.text, username);
            if (!isQuestion) {
              sendAIChatMessage(`${username}: Got it. I'm working on that now; use !ai status to check progress.`);
            }
          }
        } catch (error) {
          sendAIChatMessage(error.message);
        }
        return;
      }

      // Bot-side plugin command dispatch (e.g. !<plugincommand>) and chat hooks.
      if (pluginLoader.handleChatCommand(message, username)) return;
      try { pluginLoader.onChat(username, message); } catch (e) { console.error(`[Plugins] onChat: ${e.message}`); }

      if (config.discord?.enabled && config.discord?.events?.chat) {
        sendDiscordWebhook(`${username}: ${message}`, 0x7289da);
      }

      const plainMessage = String(message || '').trim();
      const botName = bot.username || 'virgo';
      const mentionsBot = new RegExp(`\\b${botName}\\b|^bot\\b|^hey bot\\b`, 'i').test(plainMessage);
      const trustedChatter = config.ai?.enabled && isAIChatAuthorized(username, aiAllowedUsers);
      let shouldHandle = false;
      let cleanedMessage = plainMessage;
      if (trustedChatter && plainMessage && !/^[!/]/.test(plainMessage)) {
        cleanedMessage = plainMessage.replace(new RegExp(`^(?:hey\\s+)?${botName}[,:]?\\s*`, 'i'), '').trim() || plainMessage;
        if (mentionsBot) {
          shouldHandle = true;
        } else {
          const parsed = parseLocalIntent(cleanedMessage);
          shouldHandle = parsed.type !== 'chat' || parsed.intent === 'question';
        }
      }
      if (shouldHandle) {
        const now = Date.now();
        const chatLang = detectLanguage(cleanedMessage);
        const last = lastAutoResponseAt.get(username.toLowerCase()) || 0;
        if (now - last < 2000) {
          sendAIChatMessage(`${username}: Give me a moment between requests.`);
          return;
        }
        lastAutoResponseAt.set(username.toLowerCase(), now);
        const isControlRequest = /^(?:please\s+)?(?:stop|halt|cancel|abort|enough|pause|resume|continue|keep going)\b/i.test(plainMessage);
        if (['working', 'paused'].includes(aiAgent.getStatus().status) && !isControlRequest) {
          sendAIChatMessage(`${username}: ${localizedReply('stillWorking', chatLang)}`);
          return;
        }
        try {
          const isQuestion = /\?$/.test(cleanedMessage) ||
            /^(?:who|what|how|why|when|where|which|can|could|would|will|is|are|does|do|did|tell|joke|calc|calculate|recipe|status|help)\b/i.test(cleanedMessage);
          aiAgent.start(cleanedMessage, username);
          if (!isQuestion) {
            sendAIChatMessage(`${username}: ${localizedReply('working', chatLang)}`);
          }
        } catch (error) {
          sendAIChatMessage(`${username}: ${error.message}`);
        }
        return;
      }

      if (config.chat?.respond) {
        if (message.startsWith('!tp ')) {
          if (tpWhitelist.includes(username)) {
            const target = message.split(' ')[1];
            if (target) bot.chat(`/tp ${target}`);
          } else {
            console.log(`[Chat] Ignored !tp from untrusted user: ${username}`);
          }
        }
      }
    } catch (e) {
      console.log('[Chat] Error:', e.message);
    }
  });
}

function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord?.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;

  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    console.log('[Discord] Rate limited - skipping webhook');
    return;
  }
  lastDiscordSend = now;

  const urlParts = new URL(config.discord.webhookUrl);
  const isHttps = urlParts.protocol === 'https:';
  const protocol = isHttps ? https : http;

  const payload = JSON.stringify({
    username: config.name,
    embeds: [{
      description: content,
      color: color,
      timestamp: new Date().toISOString(),
      footer: { text: config.name }
    }]
  });

  const options = {
    hostname: urlParts.hostname,
    port: urlParts.port || (isHttps ? 443 : 80),
    path: urlParts.pathname + urlParts.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',

      'Content-Length': Buffer.byteLength(payload, 'utf8')
    }
  };

  const req = protocol.request(options, (res) => {
    res.resume();
  });

  req.on('error', (e) => {
    console.log(`[Discord] Webhook error: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

process.on('uncaughtException', (err) => {
  const msg = err.message || 'Unknown';
  console.log(`[FATAL] Uncaught Exception: ${msg}`);
  pushError({ type: 'uncaught', message: msg, time: Date.now() });

  const isNetworkError = msg.includes('PartialReadError') || msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') || msg.includes('ETIMEDOUT') || msg.includes('timed out') ||
    msg.includes('write after end') || msg.includes('This socket has been ended');

  clearAllIntervals();
  clearBlockAtGuard();
  botState.connected = false;

  if (isReconnecting) {
    console.log('[FATAL] isReconnecting was stuck - resetting');
    isReconnecting = false;
    if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  }

  setTimeout(() => scheduleReconnect(), isNetworkError ? 5000 : 10000);
});

process.on('unhandledRejection', (reason) => {
  console.log(`[FATAL] Unhandled Rejection: ${reason}`);
  pushError({ type: 'rejection', message: String(reason), time: Date.now() });
});

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[System] ${signal} received - shutting down gracefully.`);
  clearBotTimeouts();
  clearAllIntervals();
  clearBlockAtGuard();
  try { if (visionController) visionController.stop(); } catch { /* ignore */ }
  try { if (viewFrameServer) viewFrameServer.stop(); } catch { /* ignore */ }
  try { if (viewerProcess) { viewerProcess.kill(); viewerProcess = null; } } catch { /* ignore */ }
  if (bot) {
    try {
      manualControlSession.release();
    } catch (err) {
      console.log(`[Controls] Could not release inputs during shutdown: ${err.message}`);
      manualControlSession.disconnect();
    }
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (err) {
      console.log(`[System] Bot shutdown warning: ${err.message}`);
    }
    bot = null;
  }
  // Clean up the force-stop marker file
  try {
    const dir = getForceStopDir();
    const markerFile = path.join(dir, 'force-stop.marker');
    const logFile = path.join(dir, 'force-stop.log');
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  } catch (e) {
    // ignore cleanup errors
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

// ── Force-stop marker file (cross-device/terminal stop) ────────────────────
// scripts/fs.js writes a marker file to the bot's state folder; this function
// checks for it every 10s and shuts down all sessions when triggered.
const FORCE_STOP_INTERVAL_MS = 10000;
let forceStopDetected = false;

function getForceStopDir() {
  const isWin = process.platform === 'win32';
  const homeDir = os.homedir();
  const appData = process.env.APPDATA || (isWin ? path.join(homeDir, 'AppData', 'Roaming') : null);
  return (appData || path.join(homeDir, '.config', 'minecraft-afk-bot', 'state'));
}

function checkForceStop() {
  const dir = getForceStopDir();
  const markerFile = path.join(dir, 'force-stop.marker');
  const logFile = path.join(dir, 'force-stop.log');
  try {
    if (fs.existsSync(markerFile)) {
      const record = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (!forceStopDetected) {
        forceStopDetected = true;
        console.log(`[FS] Force-stop marker detected from ${record.who} (location=${record.location}, pid=${record.pid}, ${record.timestamp})`);
        if (logFile && fs.existsSync(logFile)) {
          console.log(`[FS] Full log: ${logFile}`);
        }
        shutdown('SIGINT: force-stop marker');
      }
    }
  } catch (err) {
    // ignore read errors
  }
}
activeIntervals.push(setInterval(checkForceStop, FORCE_STOP_INTERVAL_MS).unref());

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('='.repeat(50));
console.log('  Minecraft AFK Bot - Fixed Edition');
console.log('='.repeat(50));
console.log(`Server:         ${config.server.ip}:${config.server.port}`);
if (String(config.server.loader || '').toLowerCase() === 'fabric') {
  console.log(
    '[Compatibility] Fabric server selected. Mineflayer is a protocol bot, ' +
    'not a Fabric client; client-required mod protocols need separate support.'
  );
}
console.log(`Bot Username:   ${process.env.BOT_USERNAME || config['bot-account'].username}`);
console.log(`Auto-Reconnect: ${config.utils['auto-reconnect'] ? 'Enabled' : 'Disabled'}`);
console.log('='.repeat(50));

createBot();
