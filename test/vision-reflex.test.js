'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VisionController, reflexAction, ACTIONS } = require('../lib/vision-controller');

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

test('reflex does not blind-jump when perception reports no clear corridor', () => {
  assert.equal(reflexAction(perception({ forwardClear: 0.4, freeCenter: 0, freeLeft: 0, freeRight: 0 })), 'none');
  assert.equal(reflexAction(perception({ forwardClear: 0.4, freeCenter: 0, freeLeft: undefined, freeRight: undefined })), 'none');
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

test('vision can use a real-client JPEG frame without the reconstructed renderer', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const controller = new VisionController({ getJpegFrame: async () => jpeg, enabled: true });
  const frame = await controller.captureFrame();
  assert.equal(frame.format, 'jpeg');
  assert.deepEqual(frame.jpeg, jpeg);
  assert.equal(controller.screenMode, true);
});

test('vision dispatches actions through the selected desktop controller', async () => {
  const actions = [];
  const controller = new VisionController({
    executeAction: async action => actions.push(action),
    enabled: true
  });
  controller.applyAction('forward');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['forward']);
});

test('reflex yields controls while a higher-level AI task is active', () => {
  const controls = [];
  const bot = {
    entity: { yaw: 0, pitch: 0 },
    health: 20,
    food: 20,
    setControlState: (key, pressed) => controls.push([key, pressed])
  };
  const controller = new VisionController({
    getBot: () => bot,
    getPerception: () => perception(),
    isConnected: () => true,
    shouldYield: () => true,
    enabled: true,
    reflex: true,
    llm: false
  });
  controller.reflexTick();
  assert.equal(bot.aiScreenControl, false);
  assert.deepEqual(controls, []);
});

test('desktop vision tick sends the exact captured JPEG to its model and applies the returned action', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x10, 0x20, 0xff, 0xd9]);
  const actions = [];
  const controller = new VisionController({
    getJpegFrame: async () => jpeg,
    executeAction: async action => actions.push(action),
    isConnected: () => true,
    enabled: true
  });
  controller.askModel = async imageBase64 => {
    assert.deepEqual(Buffer.from(imageBase64, 'base64'), jpeg);
    return 'ACTION: jump - hop over the block';
  };
  await controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(actions, ['jump']);
  assert.equal(controller.ticks, 1);
});
