'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserViewer } = require('../lib/browser-viewer');

let ioClient = null;
try { ioClient = require('socket.io-client').io; } catch { /* optional */ }

const emitAck = (socket, event, payload) => new Promise(resolve => {
  if (payload === undefined) socket.emit(event, resolve); else socket.emit(event, payload, resolve);
});

test('browser control channel: auth, validation, busy state and release on disconnect', async t => {
  const calls = [];
  let busy = false;
  const viewer = new BrowserViewer({
    port: 3190 + Math.floor(Math.random() * 100),
    token: 'secret',
    log: () => {},
    controls: {
      busy: () => busy,
      input: (input, pressed) => { calls.push(['input', input, pressed]); return [input]; },
      action: (action, payload) => { calls.push(['action', action, payload]); return { action }; },
      release: () => calls.push(['release']),
      heartbeat: () => [],
      look: (yaw, pitch) => { calls.push(['look', yaw, pitch]); },
      chat: text => { calls.push(['chat', text]); }
    }
  });
  if (!ioClient || !viewer.start()) return t.skip('prismarine-viewer or socket.io-client is not installed');
  t.after(() => viewer.stop());
  viewer.bot = { entity: {}, removeListener() {} }; // only needs to be truthy for the control channel
  await new Promise(resolve => setTimeout(resolve, 200));
  const url = `http://127.0.0.1:${viewer.server.address().port}/control`;

  const rejected = ioClient(url, { path: '/socket.io', transports: ['polling'], reconnection: false });
  const error = await new Promise(resolve => {
    rejected.on('connect_error', e => resolve(e.message));
    rejected.on('connect', () => resolve('connected'));
  });
  rejected.close();
  assert.equal(error, 'unauthorized');

  const socket = ioClient(url, { path: '/socket.io', transports: ['polling'], reconnection: false, extraHeaders: { cookie: 'viewer_token=secret' } });
  await new Promise(resolve => socket.on('connect', resolve));

  assert.deepEqual(await emitAck(socket, 'input', { input: 'forward', pressed: true }), { ok: true, result: ['forward'] });
  assert.equal((await emitAck(socket, 'input', { input: 'fly', pressed: true })).ok, false);
  assert.equal((await emitAck(socket, 'input', { input: 'forward', pressed: 'yes' })).ok, false);
  assert.equal((await emitAck(socket, 'action', { action: 'op' })).ok, false);
  assert.equal((await emitAck(socket, 'action', { action: 'slot', slot: 4 })).ok, true);
  assert.equal((await emitAck(socket, 'look', { yaw: 1, pitch: 99 })).ok, true);
  assert.equal(calls.find(c => c[0] === 'look')[2], Math.PI / 2, 'pitch is clamped');
  assert.equal((await emitAck(socket, 'look', { yaw: 'x', pitch: 0 })).ok, false);
  assert.equal((await emitAck(socket, 'chat', 'hello\nworld')).ok, true);
  assert.deepEqual(calls.find(c => c[0] === 'chat'), ['chat', 'hello world']);

  busy = true;
  const denied = await emitAck(socket, 'input', { input: 'forward', pressed: false });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /AI task/);
  busy = false;

  const before = calls.length;
  socket.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(calls.slice(before), [['release']], 'held keys are released when the browser disconnects');
});
