'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reflexAction, ACTIONS } = require('../lib/vision-controller');

function perception(overrides = {}) {
  return {
    haveWorld: true,
    haveFrame: true,
    freeCenter: 80,
    freeLeft: 50,
    freeRight: 50,
    groundPct: 60,
    skyPct: 20,
    forwardClear: 4,
    nearest: 4,
    targetKind: 0,
    targetDist: 0,
    receivedAt: Date.now(),
    ...overrides
  };
}

test('reflex walks forward on open ground', () => {
  assert.equal(reflexAction(perception()), 'forward');
});

test('reflex steers around an obstacle toward the freer side', () => {
  assert.equal(reflexAction(perception({ forwardClear: 0.6, freeCenter: 20, freeLeft: 60, freeRight: 10 })), 'turn_left');
  assert.equal(reflexAction(perception({ forwardClear: 0.6, freeCenter: 20, freeLeft: 5, freeRight: 60 })), 'turn_right');
});

test('reflex refrains from walking off the spawn platform into the void', () => {
  const platform = perception({ groundPct: 4, skyPct: 80, forwardClear: 48, nearest: 48 });
  assert.equal(reflexAction(platform), 'none');
});

test('reflex attacks a hostile within reach before moving', () => {
  assert.equal(reflexAction(perception({ targetKind: 1, targetDist: 3 })), 'attack');
});

test('reflex retreats from a hostile at low health', () => {
  assert.equal(reflexAction(perception({ targetKind: 1, targetDist: 6 }), { health: 5 }), 'retreat');
});

test('reflex stops when the perception feed is stale or missing', () => {
  assert.equal(reflexAction(null), 'stop');
  assert.equal(reflexAction(perception({ haveWorld: false })), 'stop');
  assert.equal(reflexAction(perception({ receivedAt: Date.now() - 5000 })), 'stop');
});

test('reflex output stays inside the known action set', () => {
  const samples = [
    perception(), perception({ forwardClear: 0.4 }), perception({ groundPct: 3, skyPct: 90 }),
    perception({ targetKind: 1, targetDist: 2 }), perception({ targetKind: 2, targetDist: 3 })
  ];
  for (const sample of samples) {
    assert.ok(ACTIONS.includes(reflexAction(sample)));
  }
});
