'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildViewTelemetry, getLocalViewerUrl } = require('../lib/view-telemetry');

test('viewer proxy accepts only fixed endpoints on loopback HTTP URLs', () => {
  assert.equal(getLocalViewerUrl('/frame', 'http://localhost:8080/base?token=x').href, 'http://localhost:8080/frame');
  assert.equal(getLocalViewerUrl('/state.json').href, 'http://127.0.0.1:8080/state.json');
  assert.throws(() => getLocalViewerUrl('/anything'), /Unsupported local viewer endpoint/);
  assert.throws(() => getLocalViewerUrl('/frame', 'https://127.0.0.1:8080'), /localhost/);
  assert.throws(() => getLocalViewerUrl('/frame', 'http://192.168.1.10:8080'), /localhost/);
  assert.throws(() => getLocalViewerUrl('/frame', 'http://user:pass@127.0.0.1:8080'), /localhost/);
});

test('F3 telemetry combines renderer perception with Mineflayer vitals and light values', () => {
  const bot = {
    entity: { position: { x: 1.25, y: 64, z: -2 }, yaw: Math.PI / 2, pitch: -0.25 },
    game: { dimension: 'overworld' },
    time: { timeOfDay: 18000, day: 12 },
    health: 17,
    food: 14,
    heldItem: { name: 'iron_pickaxe' },
    quickBarSlot: 2,
    blockAt: position => {
      assert.deepEqual(position, { x: 1, y: 64, z: -2 });
      return { name: 'stone', light: 3, skyLight: 7, biome: { name: 'plains' } };
    }
  };
  const state = buildViewTelemetry({
    renderer: { fps: 59, cells: 196608, entities: 2, eye: [1.25, 65.62, -2], free: { center: 96 } },
    bot,
    grid: [64, 48, 64]
  });
  assert.equal(state.connected, true);
  assert.equal(state.fps, 59);
  assert.deepEqual(state.position, { x: 1.25, y: 64, z: -2 });
  assert.equal(state.facing, 'West');
  assert.equal(state.health, 17);
  assert.equal(state.food, 14);
  assert.equal(state.blockLight, 3);
  assert.equal(state.skyLight, 7);
  assert.equal(state.biome, 'plains');
  assert.deepEqual(state.grid, [64, 48, 64]);
});

test('F3 telemetry handles absent optional world samples without inventing values', () => {
  const state = buildViewTelemetry({
    renderer: {},
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => null }
  });
  assert.equal(state.dimension, 'unknown');
  assert.equal(state.health, null);
  assert.equal(state.blockLight, null);
  assert.equal(state.block, null);
  assert.deepEqual(state.grid, null);
  assert.equal(state.facing, 'South');
});
