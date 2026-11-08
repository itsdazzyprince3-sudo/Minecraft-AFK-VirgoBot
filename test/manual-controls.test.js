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

// ---- real-player actions: mine, place, interact, equip, pick, drop from a slot -------------------
const { Vec3 } = require('vec3');

function playerBot(overrides = {}) {
  const log = [];
  const slots = new Array(46).fill(null);
  slots[36] = { name: 'stone', type: 1, count: 20, metadata: 0 };
  slots[12] = { name: 'oak_log', type: 5, count: 8, metadata: 0 };
  slots[13] = { name: 'apple', type: 9, count: 3, metadata: 0 };
  const bot = {
    log,
    heldItem: slots[36],
    controlState: { sneak: false },
    registry: { blocksByName: { stone: {}, oak_log: {}, dirt: {} } },
    inventory: { slots, items: () => slots.filter(Boolean) },
    swingArm: hand => log.push(['swing', hand]),
    attack: entity => log.push(['attack', entity.name]),
    dig: async (block, look) => { log.push(['dig', block.name, look]); },
    stopDigging: () => log.push(['stopDigging']),
    placeBlock: async (ref, face) => { log.push(['place', ref.name, [face.x, face.y, face.z]]); },
    activateBlock: async block => { log.push(['activateBlock', block.name]); },
    activateItem: () => log.push(['activateItem']),
    deactivateItem: () => log.push(['deactivateItem']),
    equip: async (item, dest) => { log.push(['equip', item.name, dest]); },
    toss: async (type, meta, count) => { log.push(['toss', type, count]); },
    tossStack: async item => { log.push(['tossStack', item.name]); },
    entity: { yaw: 0, pitch: 0 },
    ...overrides
  };
  return bot;
}
const target = (name, face = 1) => ({ name, face, position: new Vec3(5, 64, 5) });

test('attack hits an entity first, otherwise mines the block under the cursor, otherwise swings', async () => {
  const withEntity = playerBot({ entityAtCursor: () => ({ name: 'zombie' }), blockAtCursor: () => target('dirt') });
  assert.equal((await performManualAction(withEntity, 'attack')).action, 'attack');
  assert.deepEqual(withEntity.log, [['swing', 'right'], ['attack', 'zombie']]);

  const mining = playerBot({ entityAtCursor: () => null, blockAtCursor: () => target('dirt') });
  const result = await performManualAction(mining, 'attack');
  assert.deepEqual(result, { action: 'dig', block: 'dirt' });
  assert.deepEqual(mining.log, [['dig', 'dirt', 'ignore']], "digging must not snap the bot's aim");

  const nothing = playerBot({ entityAtCursor: () => null, blockAtCursor: () => null });
  assert.equal((await performManualAction(nothing, 'attack')).action, 'swing');
  assert.deepEqual(nothing.log, [['swing', 'right']]);
});

test('holding attack keeps digging the same block instead of restarting, and bedrock/air are left alone', async () => {
  const block = target('stone');
  const bot = playerBot({ entityAtCursor: () => null, blockAtCursor: () => block, targetDigBlock: { position: block.position } });
  const result = await performManualAction(bot, 'attack');
  assert.equal(result.message, 'Already digging.');
  assert.deepEqual(bot.log, []);

  for (const name of ['bedrock', 'air']) {
    const other = playerBot({ entityAtCursor: () => null, blockAtCursor: () => target(name) });
    assert.equal((await performManualAction(other, 'attack')).action, 'swing');
    assert.equal(other.log.some(entry => entry[0] === 'dig'), false);
  }
});

test('a dig that fails (out of reach, aborted) does not break the control channel', async () => {
  const bot = playerBot({ entityAtCursor: () => null, blockAtCursor: () => target('dirt'), dig: async () => { throw new Error('Digging aborted'); } });
  await assert.doesNotReject(performManualAction(bot, 'attack'));
  await new Promise(resolve => setImmediate(resolve));   // the rejected promise is handled, not unhandled
});

test('attack_release stops digging only while digging', async () => {
  const idle = playerBot();
  await performManualAction(idle, 'attack_release');
  assert.deepEqual(idle.log, []);
  const digging = playerBot({ targetDigBlock: { position: new Vec3(1, 1, 1) } });
  await performManualAction(digging, 'attack_release');
  assert.deepEqual(digging.log, [['stopDigging']]);
});

test('use places the held block on the face you are looking at', async () => {
  const bot = playerBot({ blockAtCursor: () => target('dirt', 1) });   // top face
  assert.deepEqual(await performManualAction(bot, 'use'), { action: 'place', block: 'stone' });
  assert.deepEqual(bot.log, [['place', 'dirt', [0, 1, 0]]]);
  for (const [face, vector] of [[0, [0, -1, 0]], [2, [0, 0, -1]], [3, [0, 0, 1]], [4, [-1, 0, 0]], [5, [1, 0, 0]]]) {
    const b = playerBot({ blockAtCursor: () => target('dirt', face) });
    await performManualAction(b, 'use');
    assert.deepEqual(b.log[0][2], vector, `face ${face}`);
  }
});

test('use opens chests, doors and crafting tables instead of placing, unless sneaking', async () => {
  for (const name of ['chest', 'trapped_chest', 'crafting_table', 'oak_door', 'oak_trapdoor', 'furnace', 'blast_furnace', 'red_bed', 'stone_button', 'lever', 'barrel', 'white_shulker_box', 'oak_fence_gate', 'anvil', 'ender_chest']) {
    const bot = playerBot({ blockAtCursor: () => target(name) });
    assert.equal((await performManualAction(bot, 'use')).action, 'use', name);
    assert.deepEqual(bot.log, [['activateBlock', name]], name);
  }
  const sneaking = playerBot({ blockAtCursor: () => target('chest'), controlState: { sneak: true } });
  assert.equal((await performManualAction(sneaking, 'use')).action, 'place', 'sneak-click places against a chest');
  const empty = playerBot({ blockAtCursor: () => target('chest'), controlState: { sneak: true }, heldItem: null });
  assert.equal((await performManualAction(empty, 'use')).action, 'use', 'sneaking with nothing to place still opens it');
});

test('use with a non-block item interacts with the block or uses the item; releasing stops using it', async () => {
  const food = playerBot({ heldItem: { name: 'apple', type: 9, count: 3 }, blockAtCursor: () => null });
  assert.equal((await performManualAction(food, 'use')).message, 'Activated held item.');
  assert.deepEqual(food.log, [['activateItem']]);
  const alreadyEating = playerBot({ heldItem: { name: 'apple', type: 9, count: 3 }, blockAtCursor: () => null, usingHeldItem: true });
  await performManualAction(alreadyEating, 'use');
  assert.deepEqual(alreadyEating.log, [], 'holding right-click does not restart eating');
  await performManualAction(food, 'use_release');
  assert.deepEqual(food.log.at(-1), ['deactivateItem']);
  const poke = playerBot({ heldItem: { name: 'apple', type: 9, count: 3 }, blockAtCursor: () => target('dirt') });
  assert.equal((await performManualAction(poke, 'use')).action, 'use');
  assert.deepEqual(poke.log, [['activateBlock', 'dirt']]);
});

test('equip, drop_slot and pick use real inventory slots and reject bad ones', async () => {
  const bot = playerBot();
  assert.deepEqual(await performManualAction(bot, 'equip', { slot: 12 }), { action: 'equip', item: 'oak_log', slot: 12 });
  assert.deepEqual(bot.log.at(-1), ['equip', 'oak_log', 'hand']);
  assert.equal((await performManualAction(bot, 'equip', { slot: 20 })).message, 'That slot is empty.');

  await performManualAction(bot, 'drop_slot', { slot: 13 });
  assert.deepEqual(bot.log.at(-1), ['toss', 9, 1]);
  await performManualAction(bot, 'drop_slot', { slot: 13, all: true });
  assert.deepEqual(bot.log.at(-1), ['tossStack', 'apple']);
  assert.equal((await performManualAction(bot, 'drop_slot', { slot: 30 })).message, 'That slot is empty.');

  for (const slot of [-1, 46, 1.5, 'x', undefined]) {
    await assert.rejects(performManualAction(bot, 'equip', { slot }), /Bad inventory slot/, String(slot));
    await assert.rejects(performManualAction(bot, 'drop_slot', { slot }), /Bad inventory slot/, String(slot));
  }

  const picking = playerBot({ blockAtCursor: () => target('oak_log') });
  assert.deepEqual(await performManualAction(picking, 'pick'), { action: 'pick', item: 'oak_log' });
  assert.deepEqual(picking.log.at(-1), ['equip', 'oak_log', 'hand']);
  assert.match((await performManualAction(playerBot({ blockAtCursor: () => target('diamond_block') }), 'pick')).message, /no diamond_block/);
  assert.match((await performManualAction(playerBot({ blockAtCursor: () => null }), 'pick')).message, /Not looking/);
});
