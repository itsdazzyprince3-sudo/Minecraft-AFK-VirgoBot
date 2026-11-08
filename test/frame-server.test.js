'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { FrameServer, parsePerception } = require('../lib/frame-server');

function fakeBot() {
  const bot = new EventEmitter();
  bot.username = 'Virgo';
  bot.entity = {
    position: { x: 0, y: 63, z: 0 },
    yaw: 0,
    pitch: 0
  };
  bot.entities = { 1: bot.entity };
  bot.players = {};
  bot.blockAt = ({ y }) => {
    if (y === 62) return { name: 'grass_block' };
    if (y < 62 && y > 50) return { name: 'stone' };
    return { name: 'air' };
  };
  return bot;
}

function readMessages(socket) {
  let buffered = Buffer.alloc(0);
  const messages = [];
  socket.on('data', (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    while (buffered.length >= 8) {
      const tag = buffered.toString('ascii', 0, 4);
      const len = buffered.readUInt32LE(4);
      if (buffered.length < 8 + len) break;
      messages.push({ tag, payload: buffered.subarray(8, 8 + len) });
      buffered = buffered.subarray(8 + len);
    }
  });
  return messages;
}

async function waitForMessage(messages, tag, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = messages.find(message => message.tag === tag);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${tag}`);
}

test('frame server sends a VWLD snapshot matching the grid layout', async () => {
  const bot = fakeBot();
  const server = new FrameServer({ getBot: () => bot, isConnected: () => true, port: 0, w: 16, h: 16, d: 16 });
  server.start();
  await once(server, 'listening');
  const socket = net.connect(server.port, '127.0.0.1');
  await once(socket, 'connect');
  const messages = readMessages(socket);
  const world = await waitForMessage(messages, 'VWLD');
  const ox = world.payload.readInt32LE(0);
  const oy = world.payload.readInt32LE(4);
  const oz = world.payload.readInt32LE(8);
  const w = world.payload.readUInt16LE(12);
  const h = world.payload.readUInt16LE(14);
  const d = world.payload.readUInt16LE(16);
  assert.equal(w, 16); assert.equal(h, 16); assert.equal(d, 16);
  const grid = world.payload.subarray(20);
  assert.equal(grid.length, 16 * 16 * 16);
  const gy = 62 - oy;
  const gx = 0 - ox;
  const gz = 0 - oz;
  const kind = grid[gx + w * (gz + d * gy)];
  assert.equal(kind, 3, 'grass_block maps to render kind 3 at the bot feet');
  socket.destroy();
  server.stop();
});

test('frame server forwards block updates as VBLK deltas', async () => {
  const bot = fakeBot();
  const server = new FrameServer({ getBot: () => bot, isConnected: () => true, port: 0, w: 16, h: 16, d: 16 });
  server.start();
  await once(server, 'listening');
  const socket = net.connect(server.port, '127.0.0.1');
  await once(socket, 'connect');
  const messages = readMessages(socket);
  await waitForMessage(messages, 'VWLD');
  bot.emit('blockUpdate', { position: { x: 0, y: 62, z: 0 }, name: 'grass_block' },
    { position: { x: 0, y: 62, z: 0 }, name: 'dirt' });
  server.tick();
  const delta = await waitForMessage(messages, 'VBLK');
  const count = delta.payload.readUInt16LE(0);
  assert.equal(count, 1);
  const rx = delta.payload.readInt16LE(2);
  const ry = delta.payload.readInt16LE(4);
  const rz = delta.payload.readInt16LE(6);
  assert.equal(delta.payload.readUInt8(8), 2, 'dirt maps to render kind 2');
  const origin = server.world.origin;
  assert.equal(rx, -origin.x);
  assert.equal(ry, 62 - origin.y);
  assert.equal(rz, -origin.z);
  socket.destroy();
  server.stop();
});

test('frame server parses PERC perception from the viewer', async () => {
  const bot = fakeBot();
  const server = new FrameServer({ getBot: () => bot, isConnected: () => true, port: 0, w: 16, h: 16, d: 16 });
  server.start();
  await once(server, 'listening');
  const socket = net.connect(server.port, '127.0.0.1');
  await once(socket, 'connect');
  const perception = Buffer.alloc(28);
  perception.writeUInt32LE(7, 0);
  perception.writeUInt16LE(61, 4);
  perception.writeUInt8(3, 6); // world + frame
  perception.writeUInt8(80, 7);
  perception.writeUInt8(30, 8);
  perception.writeUInt8(40, 9);
  perception.writeUInt8(70, 10);
  perception.writeUInt8(25, 11);
  perception.writeFloatLE(3.5, 12);
  perception.writeFloatLE(2.25, 16);
  perception.writeInt16LE(160, 20);
  perception.writeInt16LE(90, 22);
  perception.writeUInt8(1, 24);
  perception.writeUInt8(4, 25);
  const message = Buffer.alloc(8 + perception.length);
  message.write('PERC', 0, 'ascii');
  message.writeUInt32LE(perception.length, 4);
  perception.copy(message, 8);
  const seen = once(server, 'perception');
  socket.write(message);
  const [received] = await seen;
  assert.equal(received.seq, 7);
  assert.equal(received.fps, 61);
  assert.equal(received.haveWorld, true);
  assert.equal(received.haveFrame, true);
  assert.equal(received.freeCenter, 80);
  assert.equal(received.freeLeft, 30);
  assert.equal(received.freeRight, 40);
  assert.equal(received.groundPct, 70);
  assert.equal(received.skyPct, 25);
  assert.ok(Math.abs(received.forwardClear - 3.5) < 1e-5);
  assert.ok(Math.abs(received.nearest - 2.25) < 1e-5);
  assert.equal(received.targetSx, 160);
  assert.equal(received.targetSy, 90);
  assert.equal(received.targetKind, 1);
  assert.equal(received.targetDist, 4);
  assert.equal(parsePerception(perception).seq, 7);
  socket.destroy();
  server.stop();
});
