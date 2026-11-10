'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { AISkills } = require('../lib/ai-skills');

function makeSkills(bot) {
  const agent = { runId: 1, requestedBy: 'virgo' };
  return new AISkills({ agent, getBot: () => bot, memory: null, runId: 1 });
}

test('combat skill ignores players and only selects known hostile mobs', async () => {
  const attacks = [];
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      player: { id: 1, type: 'player', name: 'virgo', position: new Vec3(1, 64, 0) },
      zombiePlayer: { id: 2, type: 'player', name: 'zombie', position: new Vec3(2, 64, 0) }
    },
    inventory: { items: () => [] },
    attack: entity => attacks.push(entity)
  };
  const result = await makeSkills(bot).attackNearest('virgo');
  assert.deepEqual(result, { message: 'No hostile mobs nearby.' });
  assert.deepEqual(attacks, []);
  assert.deepEqual(await makeSkills(bot).attackNearest('zombie'), { message: 'No hostile mobs nearby.' });
  await assert.rejects(makeSkills(bot).attackEntity(bot.entities.zombiePlayer), /never a player/i);
  assert.deepEqual(attacks, []);
});

test('bed inventory recognizes colored variants and sleep refuses unsafe or unavailable conditions', async () => {
  const bedItem = { name: 'white_bed', count: 1 };
  const baseBot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0), equipment: [] },
    inventory: { items: () => [bedItem] },
    findBlock: () => null,
    entities: {},
    health: 20,
    food: 20,
    time: { isDay: false }
  };
  const skills = makeSkills(baseBot);
  assert.equal(skills.countItem('bed'), 1);
  assert.equal(skills.findInventoryItem('bed'), bedItem);

  const unsafeBot = {
    ...baseBot,
    entities: { zombie: { id: 3, type: 'mob', name: 'zombie', position: new Vec3(3, 64, 0) } }
  };
  await assert.rejects(makeSkills(unsafeBot).sleep(), /while a zombie is within 8 blocks/i);

  const noBedBot = { ...baseBot, inventory: { items: () => [] }, entities: {} };
  await assert.rejects(makeSkills(noBedBot).sleep(), /No bed is nearby or in my inventory/i);
});


test('observation includes dimension, weather, equipped armor, hazards, and recent events', () => {
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0), equipment: [null, null, { name: 'iron_boots' }, null, { name: 'iron_chestplate' }, { name: 'iron_helmet' }] },
    inventory: { items: () => [] },
    findBlocks: () => [new Vec3(2, 64, 0)],
    blockAt: () => ({ name: 'lava', position: new Vec3(2, 64, 0) }),
    entities: {}, players: {}, health: 18, food: 14, oxygenLevel: 20,
    time: { timeOfDay: 13000, day: 4, isDay: false },
    game: { dimension: 'overworld' }, isRaining: true, thunderState: 1,
    aiRecentEvents: [{ type: 'damage', detail: 'Health fell', at: 1 }]
  };
  const observation = makeSkills(bot).observation();
  assert.equal(observation.dimension, 'overworld');
  assert.deepEqual(observation.weather, { raining: true, thunder: true });
  assert.equal(observation.armor.boots, 'iron_boots');
  assert.equal(observation.armor.chestplate, 'iron_chestplate');
  assert.equal(observation.hazards[0].name, 'lava');
  assert.equal(observation.recentEvents[0].type, 'damage');
});

test('navigation retries once after a pathfinding failure and then succeeds', async () => {
  let attempts = 0;
  const bot = {
    pathfinder: {
      goto: async () => { attempts += 1; if (attempts === 1) throw new Error('No path'); return 'arrived'; },
      stop() {}
    },
    clearControlStates() {}
  };
  const result = await makeSkills(bot).goto({ x: 1, y: 64, z: 1 }, { timeoutMs: 1000 });
  assert.equal(result, 'arrived');
  assert.equal(attempts, 2);
});


test('combat equips better available armor before engaging a hostile mob', async () => {
  const equipped = [];
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0), equipment: [null, null, { name: 'leather_boots' }, null, null, null] },
    entities: {},
    inventory: { items: () => [
      { name: 'iron_boots', count: 1 },
      { name: 'diamond_chestplate', count: 1 }
    ] },
    equip: async (item, slot) => { equipped.push([item.name, slot]); }
  };
  const skills = makeSkills(bot);
  const result = await skills.equipBestArmor();
  assert.deepEqual(result, ['iron_boots', 'diamond_chestplate']);
  assert.deepEqual(equipped, [['iron_boots', 'feet'], ['diamond_chestplate', 'torso']]);
});


test('wood gathering fails honestly when log blocks break but no log items enter inventory', async () => {
  const logPosition = new Vec3(1, 64, 0);
  let scans = 0;
  const progress = [];
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0), equipment: [] },
    inventory: { items: () => [] },
    registry: { blocksByName: { oak_log: { id: 1 } } },
    findBlocks: options => options.point ? [] : (++scans === 1 ? [logPosition] : []),
    blockAt: position => position.y < 64
      ? { name: 'dirt', position }
      : { name: 'oak_log', position, diggable: true },
    entities: {}, players: {}, health: 20, food: 20,
    game: { dimension: 'overworld' }
  };
  const skills = makeSkills(bot);
  skills.goto = async () => {};
  skills.chopReachableLogs = async () => 8;
  skills.explore = async () => ({ message: 'scouted' });
  skills.onProgress = message => progress.push(message);
  await assert.rejects(skills.gatherWood(8), /chopped 8 log block\(s\), but no log drops reached my inventory/i);
  assert.equal(skills.countItem('oak_log'), 0);
  assert.equal(progress.some(message => /8 collected/i.test(message)), false);
});

test('equipment slots map armor, off-hand, and tools correctly', () => {
  const skills = makeSkills({
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    entities: {}
  });
  assert.equal(skills.equipmentSlot('iron_helmet'), 'head');
  assert.equal(skills.equipmentSlot('diamond_chestplate'), 'torso');
  assert.equal(skills.equipmentSlot('netherite_leggings'), 'legs');
  assert.equal(skills.equipmentSlot('golden_boots'), 'feet');
  assert.equal(skills.equipmentSlot('shield'), 'off-hand');
  assert.equal(skills.equipmentSlot('diamond_pickaxe'), 'hand');
});

test('hunt and breed guard against unknown targets and missing animals', async () => {
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    entities: {}
  };
  await assert.rejects(makeSkills(bot).huntMob('player'), /do not hunt/);
  await assert.rejects(makeSkills(bot).huntMob('zombie'), /could not reach or defeat/);
  await assert.rejects(makeSkills(bot).breedAnimal('zombie'), /do not know how to breed/);
  await assert.rejects(makeSkills(bot).breedAnimal('cow'), /need two/);
});

test('mining falls back to registry blocks outside the hand-written whitelist', () => {
  const skills = makeSkills({
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    entities: {},
    registry: {
      blocksByName: { ancient_debris: { name: 'ancient_debris', harvestTools: { 1: 'netherite_pickaxe' }, boundingBox: 'block' } },
      items: { 1: { name: 'netherite_pickaxe' } }
    }
  });
  assert.deepEqual(skills.blockNamesForItem('ancient_debris'), ['ancient_debris']);
});

test('tunnel direction avoids lava and picks the safer axis', () => {
  const origin = new Vec3(0, 64, 0).floored();
  const blocks = new Map();
  const set = (x, y, z, name) => blocks.set(`${x},${y},${z}`, { name, diggable: true, boundingBox: 'block' });
  for (let step = 1; step <= 4; step += 1) {
    set(0, 64, -step, 'lava');
    set(0, 65, -step, 'lava');
    set(step, 64, 0, 'stone');
    set(step, 65, 0, 'stone');
  }
  const bot = {
    username: 'commotozze',
    entity: { position: origin },
    inventory: { items: () => [] },
    entities: {},
    blockAt: position => blocks.get(`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`) || { name: 'air', diggable: true, boundingBox: 'empty' }
  };
  const skills = makeSkills(bot);
  assert.notEqual(skills.pickTunnelDirection(bot), 'north');
  assert.equal(skills.pickTunnelDirection(bot), 'east');
});

test('withdraw pulls the requested amount from a nearby chest', async () => {
  const withdrawn = [];
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    entities: {},
    registry: { itemsByName: { iron_ingot: { id: 1, name: 'iron_ingot' } } },
    findBlock: () => ({ name: 'chest', position: new Vec3(1, 64, 0) }),
    openChest: async () => ({
      containerItems: () => [
        { name: 'iron_ingot', type: 1, count: 5 },
        { name: 'iron_ingot', type: 1, count: 7 }
      ],
      withdraw: async (type, meta, count) => withdrawn.push(count),
      close: () => {}
    })
  };
  const result = await makeSkills(bot).withdrawItem('iron_ingot', 9);
  assert.match(result.message, /Withdrew 9 iron ingot/);
  assert.deepEqual(withdrawn, [5, 4]);
});

test('comeToPlayer navigates to players beyond 64 blocks without distance limits', async () => {
  let destination = null;
  const playerEntity = {
    position: new Vec3(100, 64, 120) // ~156 blocks away
  };
  const bot = {
    username: 'virgo_bot',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    entities: {},
    players: {
      paneer: { username: 'paneer', entity: playerEntity }
    }
  };
  const skills = makeSkills(bot);
  skills.goto = async goal => {
    destination = goal;
    // Simulate arriving at player position
    bot.entity.position = new Vec3(playerEntity.position.x, playerEntity.position.y, playerEntity.position.z);
    return true;
  };

  const result = await skills.comeToPlayer('paneer');
  assert.match(result.message, /paneer/);
  assert.equal(destination.x, 100);
  assert.equal(destination.z, 120);
});

test('skills execute drop, look, hotbar slot, swing, and use actions', async () => {
  const log = [];
  const fakeBot = {
    username: 'virgo_bot',
    heldItem: { name: 'iron_ingot', type: 42, count: 5 },
    inventory: {
      items: () => [{ name: 'iron_ingot', type: 42, count: 5 }]
    },
    registry: { itemsByName: { iron_ingot: { id: 42, name: 'iron_ingot' } } },
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    entities: {},
    players: {},
    toss: async (id, meta, count) => log.push(['toss', id, count]),
    setQuickBarSlot: slot => log.push(['slot', slot]),
    swingArm: hand => log.push(['swing', hand]),
    activateItem: () => log.push(['activateItem']),
    look: async (yaw, pitch) => log.push(['look', yaw, pitch]),
    lookAt: async (pos) => log.push(['lookAt', pos])
  };

  const skills = makeSkills(fakeBot);

  // Drop
  const dropRes = await skills.dropItem('iron_ingot', 2);
  assert.match(dropRes.message, /Dropped 2 iron ingot/);
  assert.deepEqual(log[0], ['toss', 42, 2]);

  // Slot
  const slotRes = await skills.selectSlot(4);
  assert.match(slotRes.message, /Selected hotbar slot 4/);
  assert.deepEqual(log[1], ['slot', 3]);

  // Swing
  const swingRes = await skills.swingArm();
  assert.match(swingRes.message, /Swung arm/);
  assert.deepEqual(log[2], ['swing', 'right']);

  // Use
  const useRes = await skills.useHeldItem();
  assert.match(useRes.message, /Used held item/);
  assert.deepEqual(log[3], ['activateItem']);

  // Look
  const lookRes = await skills.lookAtTarget('up');
  assert.match(lookRes.message, /Looking straight up/);
  assert.equal(log[4][0], 'look');
});

test('door use navigates to the nearest door and activates it without breaking it', async () => {
  const door = { name: 'oak_door', position: new Vec3(3, 64, 0) };
  let activated = null;
  let destination = null;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [] },
    findBlock: options => options.matching(door) ? door : null,
    blockAt: () => door,
    lookAt: async () => {},
    activateBlock: async block => { activated = block; }
  };
  const skills = makeSkills(bot);
  skills.goto = async goal => { destination = goal; };

  const result = await skills.useHeldItem('door');
  assert.equal(activated, door);
  assert.equal(destination.x, 3);
  assert.match(result.message, /used the oak door/i);
});

test('local mining guard recognizes interactable home blocks and nearby build markers', () => {
  const markerPosition = new Vec3(2, 64, 0);
  const bot = {
    findBlocks: options => options.point.distanceTo(markerPosition) <= 5 && options.matching({ name: 'oak_door' })
      ? [markerPosition]
      : [],
    blockAt: () => ({ name: 'oak_door' })
  };
  const skills = makeSkills(bot);
  assert.equal(skills.isProtectedMiningTarget(bot, { name: 'oak_door', position: markerPosition }), true);
  assert.equal(skills.isProtectedMiningTarget(bot, { name: 'stone', position: new Vec3(3, 64, 0) }), true);
  assert.equal(skills.isProtectedMiningTarget(bot, { name: 'stone', position: new Vec3(20, 64, 0) }), false);
});

test('autonomous mining is restricted to tree logs in the deterministic skill layer', async () => {
  const bot = { registry: { blocksByName: { stone: { id: 1 } } } };
  const skills = new AISkills({
    agent: { runId: 1, isAutonomousTask: true },
    getBot: () => bot,
    memory: null,
    runId: 1
  });
  await assert.rejects(skills.mine('stone'), /restricted to natural tree logs/i);
});

test('follow refuses distant players and stops immediately at critical health', async () => {
  let goalSet = false;
  let stopped = false;
  const target = { position: new Vec3(100, 64, 0) };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    health: 5,
    players: { virgo: { entity: { position: new Vec3(2, 64, 0) } } },
    entities: {},
    pathfinder: { setGoal: () => { goalSet = true; }, stop: () => { stopped = true; } }
  };
  const skills = makeSkills(bot);
  bot.players.virgo.entity = target;
  await assert.rejects(skills.followPlayer(), /within 64 blocks/i);
  assert.equal(goalSet, false);

  bot.players.virgo.entity = { position: new Vec3(2, 64, 0) };
  const result = await skills.followPlayer();
  assert.match(result.message, /health is low/i);
  assert.equal(goalSet, true);
  assert.equal(stopped, true);
});

test('sortChests deposits surplus materials while preserving tools and primary food', async () => {
  const deposited = [];
  const fakeChestWindow = {
    deposit: async (type, meta, count) => {
      deposited.push({ type, count });
    },
    close: () => {}
  };

  const chestPos = new Vec3(2, 64, 0);
  const fakeBot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => [
        { slot: 36, name: 'diamond_sword', type: 101, count: 1 },
        { slot: 37, name: 'cooked_beef', type: 102, count: 32 },
        { slot: 38, name: 'iron_ingot', type: 103, count: 15 },
        { slot: 39, name: 'cobblestone', type: 104, count: 64 },
        { slot: 40, name: 'bread', type: 105, count: 10 }
      ]
    },
    findBlock: ({ matching }) => {
      if (matching({ name: 'chest' })) {
        return { name: 'chest', position: chestPos };
      }
      return null;
    },
    pathfinder: {
      goto: async () => {},
      setGoal: () => {}
    },
    openChest: async () => fakeChestWindow
  };

  const skills = makeSkills(fakeBot);
  const result = await skills.sortChests('ores');
  assert.equal(result.totalDeposited, 15);
  assert.deepEqual(deposited, [{ type: 103, count: 15 }]);
  assert.match(result.message, /15 iron ingot/);
});

test('locateItem locates items in inventory and memory-indexed chests', async () => {
  const fakeBot = {
    username: 'commotozze',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => [{ name: 'diamond', count: 5 }]
    }
  };
  const agent = { runId: 1, requestedBy: 'virgo' };
  const memory = {
    findItemInChests: item => item === 'diamond' ? [{ chest: { x: 10, y: 64, z: 20 }, name: 'diamond', count: 32 }] : []
  };
  const skills = new AISkills({ agent, getBot: () => fakeBot, memory, runId: 1 });
  const res = await skills.locateItem('diamond');
  assert.match(res.message, /In bot inventory: 5 diamond/);
  assert.match(res.message, /32x in chest at 10, 64, 20/);
});
