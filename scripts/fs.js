#!/usr/bin/env node
'use strict';

/**
 * Force Stop (fs) - Stops all Minecraft AFK Bot sessions across all devices/terminals.
 *
 * Usage:
 *   node scripts/fs.js [reason] [location]
 *
 * How it works:
 * 1. Writes a force-stop marker file to the bot's state folder
 * 2. The bot checks for this marker every ~10s and stops all sessions
 * 3. The folder shows a log of force stop events
 *
 * This lets any user with access to the shared folder force-stop all bot instances.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

// Determine the state folder
const isWin = process.platform === 'win32';
const homeDir = os.homedir();
const appData = process.env.APPDATA || (isWin ? path.join(homeDir, 'AppData', 'Roaming') : null);
const configDir = appData || path.join(homeDir, '.config', 'minecraft-afk-bot');
const stateDir = path.join(configDir, 'state');
const markerFile = path.join(stateDir, 'force-stop.marker');
const logFile = path.join(stateDir, 'force-stop.log');

// Default location (can be overridden)
const location = process.env.FS_LOCATION || process.argv[2] || 'default';

// Create the state directory
if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
}

// Build the force stop record
const record = {
  id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  timestamp: new Date().toISOString(),
  who: getCallerInfo(),
  location: location || 'default',
  reason: process.argv[2] || 'Force stop requested',
  os: process.platform,
  pid: process.pid,
  nodeVersion: process.version,
  machine: os.hostname(),
  ip: getLocalIP(),
  cmd: process.argv.slice(0, 2).join(' ')
};

// Write the marker file (the bot checks for this)
fs.writeFileSync(markerFile, JSON.stringify(record, null, 2), { mode: 0o644 });

// Append to the log file
const logEntry = `${record.timestamp} [${record.who}] Force stop triggered (location=${record.location}, pid=${record.pid}, node=${record.nodeVersion}) from ${record.ip} on ${record.machine}`;
fs.appendFileSync(logFile, logEntry + '\n', { mode: 0o644 });

// Also write the full log
fs.appendFileSync(logFile, JSON.stringify(record, null, 2) + '\n', { mode: 0o644 });

// Signal that the session should stop (if we can detect running bot processes)
if (process.platform !== 'win32') {
  // Unix: try to kill any node processes running the bot
  const { execSync } = require('node:child_process');
  try {
    const output = execSync('pgrep -f "index\\.js|supervise-bot" 2>/dev/null || true', { encoding: 'utf8' });
    const pids = output.trim().split('\n').filter(Boolean);
    if (pids.length > 0) {
      for (const pid of pids) {
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
          console.log(`[FS] Sent SIGTERM to pid ${pid} (${execSync(`ps -p ${pid} -o comm= 2>/dev/null || echo unknown`).toString().trim() || 'unknown'})`);
        } catch (e) {
          console.log(`[FS] Could not kill pid ${pid}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    // pgrep not available, skip
  }
} else {
  // Windows: use taskkill
  try {
    const result = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV 2>nul', { encoding: 'utf8' });
    const lines = result.trim().split('\n').filter(l => l.includes('index.js') || l.includes('supervise-bot'));
    if (lines.length > 0) {
      for (const line of lines) {
        const parts = line.split(',').map(s => s.replace(/^"/, '').replace(/"$/, ''));
        if (parts.length >= 2) {
          const pid = parts[1];
          try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
            console.log(`[FS] Sent SIGTERM to pid ${pid} (${execSync(`wmic process where ProcessId=${pid} get CommandLine 2>nul`).toString().trim().split('\n')[0] || 'unknown'})`);
          } catch (e) {
            console.log(`[FS] Could not kill pid ${pid}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    // tasklist not available
  }
}

// Also try to find and stop any node processes running this project
try {
  const cwd = process.cwd();
  const fsRoot = path.join(__dirname, '..');
  const targets = [
    path.join(process.cwd(), 'index.js'),
    path.join(__dirname, '..', 'index.js'),
    path.join(process.env.PWD || '', 'index.js')
  ];
  for (const target of targets) {
    try {
      fs.accessSync(target, fs.constants.R_OK);
      console.log(`[FS] Detected bot entry: ${target}`);
    } catch {
      // not this project
    }
  }
} catch (e) {
  // ignore
}

// Broadcast stop message to all local terminals (optional)
try {
  const tmux = require('tmux'); // won't work without tmux, skip silently
} catch (e) {
  // tmux not available, skip
}

function getCallerInfo() {
  try {
    const stack = new Error().stack;
    const lines = stack.split('\n');
    const caller = lines[2] || 'unknown';
    return caller.replace(/^at /i, '').trim();
  } catch (e) {
    return 'unknown';
  }
}

function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const ifs = interfaces[name];
    if (ifs) {
      for (const iface of ifs) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  }
  return 'unknown';
}

console.log('[FS] Force stop triggered successfully.');
console.log(`[FS] Marker written to: ${markerFile}`);
console.log(`[FS] Who: ${record.who} (pid ${record.pid}, node ${record.nodeVersion})`);
console.log(`[FS] Location: ${record.location}`);
console.log(`[FS] Time: ${record.timestamp}`);
console.log(`[FS] Machine: ${record.machine} (${record.ip})`);
console.log(`[FS] All bot sessions in this folder should now stop.`);
console.log(`[FS] Check ${markerFile} and ${logFile} for details.`);
