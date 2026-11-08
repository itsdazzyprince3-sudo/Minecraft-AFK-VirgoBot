'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserViewer, secretsMatch, readCookie } = require('../lib/browser-viewer');

test('secretsMatch only accepts an identical non-empty secret', () => {
  assert.equal(secretsMatch('abc123', 'abc123'), true);
  assert.equal(secretsMatch('abc123', 'abc124'), false);
  assert.equal(secretsMatch('abc123', 'abc'), false);
  assert.equal(secretsMatch('', ''), false);
  assert.equal(secretsMatch(undefined, undefined), false);
});

test('readCookie extracts and decodes a named cookie', () => {
  assert.equal(readCookie('a=1; viewer_token=t%30ken; b=2', 'viewer_token'), 't0ken');
  assert.equal(readCookie('a=1', 'viewer_token'), '');
  assert.equal(readCookie(undefined, 'viewer_token'), '');
});

test('viewer authorizes by query token or cookie and rejects everything else', () => {
  const viewer = new BrowserViewer({ token: 'secret', log: () => {} });
  assert.equal(viewer.isAuthorized('', 'secret'), true);
  assert.equal(viewer.isAuthorized('viewer_token=secret', ''), true);
  assert.equal(viewer.isAuthorized('viewer_token=wrong', 'nope'), false);
  assert.equal(viewer.isAuthorized('', ''), false);
});

test('viewer refuses to start without a dashboard token', () => {
  const logs = [];
  const viewer = new BrowserViewer({ token: '', log: message => logs.push(message) });
  assert.equal(viewer.start(), false);
  assert.match(logs[0], /DASHBOARD_TOKEN/);
});

test('hudState reports health, hunger, XP, hotbar, facing and chat for the overlay', () => {
  const viewer = new BrowserViewer({ token: 'secret', log: () => {} });
  assert.deepEqual(viewer.hudState(), { connected: false });

  const slots = new Array(46).fill(null);
  slots[36] = { name: 'diamond_pickaxe', count: 1 };
  slots[38] = { name: 'cobblestone', count: 64 };
  const listeners = {};
  const bot = {
    version: '1.21.4',
    health: 14, food: 15, quickBarSlot: 2,
    experience: { level: 7, progress: 0.6 },
    entity: { position: { x: 1, y: 64, z: -3 }, yaw: Math.PI, effects: {} },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000 },
    inventory: { slots },
    on(name, fn) { listeners[name] = fn; },
    removeListener(name) { delete listeners[name]; }
  };
  viewer.attach(bot);
  listeners.messagestr('<Tester> hi');
  const state = viewer.hudState();
  assert.equal(state.connected, true);
  assert.equal(state.health, 14);
  assert.equal(state.food, 15);
  assert.equal(state.slot, 2);
  assert.equal(state.xpLevel, 7);
  assert.equal(state.facing, 'north');
  assert.deepEqual(state.hotbar[0], { name: 'diamond_pickaxe', count: 1 });
  assert.equal(state.hotbar[1], null);
  assert.equal(state.hotbar[2].count, 64);
  assert.equal(state.chat[0].text, '<Tester> hi');
  viewer.detach();
  assert.equal(listeners.messagestr, undefined);
});

test('chat buffer keeps only the newest 20 messages', () => {
  const viewer = new BrowserViewer({ token: 'secret', log: () => {} });
  for (let i = 0; i < 30; i += 1) viewer.onChat(`line ${i}`);
  assert.equal(viewer.chat.length, 20);
  assert.equal(viewer.chat[0].text, 'line 10');
});
