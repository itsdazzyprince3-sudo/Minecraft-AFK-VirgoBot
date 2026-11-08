'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ManualControlSession,
  performManualAction,
  setManualControl,
  releaseManualControls
} = require('../lib/manual-controls');

function createFakeBot() {
  const calls = [];
  return {
    calls,
    pathfinder: { stop: () => calls.push(['stop']) },
    setControlState: (input, pressed) => calls.push([input, pressed])
  };
}

test('manual controls pause pathfinding once and support simultaneous inputs', () => {
  const bot = createFakeBot();
  const active = new Set();

  setManualControl(bot, active, 'forward', true);
  setManualControl(bot, active, 'jump', true);
  setManualControl(bot, active, 'forward', false);

  assert.deepEqual(bot.calls, [
    ['stop'],
    ['forward', true],
    ['jump', true],
    ['forward', false]
  ]);
  assert.deepEqual([...active], ['jump']);
});

test('release clears held controls and is safe after the bot disconnects', () => {
  const bot = createFakeBot();
  const active = new Set(['left', 'sprint']);

  releaseManualControls(bot, active);
  releaseManualControls(null, active);

  assert.deepEqual(bot.calls, [['left', false], ['sprint', false]]);
  assert.equal(active.size, 0);
});

test('manual controls reject unknown inputs and non-boolean states', () => {
  const bot = createFakeBot();
  const active = new Set();

  assert.throws(() => setManualControl(bot, active, 'attack', true), /Unsupported/);
  assert.throws(() => setManualControl(bot, active, 'forward', 'yes'), /boolean/);
  assert.equal(active.size, 0);
});

test('manual control lease releases held inputs if the web client disappears', () => {
  const bot = createFakeBot();
  const timers = [];
  const expirations = [];
  const session = new ManualControlSession({
    getBot: () => bot,
    isConnected: () => true,
    leaseMs: 1000,
    setTimeoutImpl: callback => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: timer => { timer.cleared = true; },
    onExpire: error => expirations.push(error || null)
  });

  session.set('forward', true);
  session.heartbeat();
  assert.equal(timers[0].cleared, true);
  timers[1].callback();

  assert.deepEqual(bot.calls, [['stop'], ['forward', true], ['forward', false]]);
  assert.equal(session.active.size, 0);
  assert.deepEqual(expirations, [null]);
});

test('performManualAction executes drop, attack, use, slot, and look', async () => {
  const actions = [];
  const fakeBot = {
    heldItem: { name: 'diamond_sword', type: 101, count: 1 },
    toss: async (type, meta, count) => actions.push(['toss', type, count]),
    swingArm: hand => actions.push(['swing', hand]),
    activateItem: () => actions.push(['activateItem']),
    setQuickBarSlot: slot => actions.push(['setQuickBarSlot', slot]),
    look: async (yaw, pitch) => actions.push(['look', yaw, pitch]),
    entity: { yaw: 0, pitch: 0 }
  };

  const dropRes = await performManualAction(fakeBot, 'drop');
  assert.equal(dropRes.action, 'drop');
  assert.deepEqual(actions[0], ['toss', 101, 1]);

  const attackRes = await performManualAction(fakeBot, 'attack');
  assert.equal(attackRes.action, 'swing');
  assert.deepEqual(actions[1], ['swing', 'right']);

  const useRes = await performManualAction(fakeBot, 'use');
  assert.equal(useRes.action, 'use');
  assert.deepEqual(actions[2], ['activateItem']);

  const slotRes = await performManualAction(fakeBot, 'slot', { slot: 4 });
  assert.equal(slotRes.action, 'slot');
  assert.deepEqual(actions[3], ['setQuickBarSlot', 4]);

  const lookRes = await performManualAction(fakeBot, 'look', { yaw: 1.2, pitch: -0.4 });
  assert.equal(lookRes.action, 'look');
  assert.deepEqual(actions[4], ['look', 1.2, -0.4]);
});

test('index.js passes full JavaScript syntax compilation without errors', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.doesNotThrow(() => {
    new vm.Script(code, { filename: 'index.js' });
  });

  // Verify server offline keywords, kick formatting, safe chat queue, digging ability, and reconnection warning logic exist
  assert.ok(code.includes('isServerOfflineError'));
  assert.ok(code.includes('formatKickReason'));
  assert.ok(code.includes('enqueueSafeChat'));
  assert.ok(code.includes('physicsTick'));
  assert.ok(code.includes('defaultMove.canDig = true'));
  assert.ok(code.includes('offline-warning-card'));
  assert.ok(code.includes('Minecraft Server is Offline!'));
  assert.ok(code.includes('econnrefused'));
  assert.ok(code.includes('econnreset'));
});

test('all critical lib files pass JavaScript syntax compilation without errors', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['ai-skills.js', 'ai-agent.js', 'ai-brain.js', 'ai-memory.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.doesNotThrow(() => {
      new vm.Script(code, { filename: f });
    }, `Syntax check failed for ${f}`);
  }
});
