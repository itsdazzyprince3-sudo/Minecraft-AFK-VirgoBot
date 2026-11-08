'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');

test('radar calculation categorizes entities correctly within 32 blocks', () => {
  const HOSTILE_SET = new Set([
    'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman'
  ]);

  const botPos = new Vec3(100, 64, 200);
  const entities = {
    1: { id: 1, type: 'player', username: 'Alex', position: new Vec3(105, 64, 205) },
    2: { id: 2, type: 'mob', name: 'zombie', position: new Vec3(102, 64, 203) },
    3: { id: 3, type: 'animal', name: 'cow', position: new Vec3(95, 64, 195) },
    4: { id: 4, type: 'item', name: 'item', position: new Vec3(101, 64, 200) },
    5: { id: 5, type: 'player', username: 'FarPlayer', position: new Vec3(500, 64, 500) } // > 32 blocks
  };

  const results = [];
  for (const entity of Object.values(entities)) {
    const dx = entity.position.x - botPos.x;
    const dy = entity.position.y - botPos.y;
    const dz = entity.position.z - botPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 32) continue;

    let category = 'other';
    const name = String(entity.name || entity.username || '').toLowerCase();
    if (entity.type === 'player' || entity.username) {
      category = 'player';
    } else if (HOSTILE_SET.has(name) || entity.type === 'hostile' || entity.type === 'mob') {
      category = HOSTILE_SET.has(name) ? 'hostile' : 'passive';
    } else if (entity.type === 'animal') {
      category = 'passive';
    } else if (entity.name === 'item' || entity.type === 'item') {
      category = 'item';
    }

    results.push({ id: entity.id, name: entity.username || entity.name, type: category, dist });
  }

  assert.equal(results.length, 4); // FarPlayer excluded
  assert.equal(results.find(r => r.name === 'Alex').type, 'player');
  assert.equal(results.find(r => r.name === 'zombie').type, 'hostile');
  assert.equal(results.find(r => r.name === 'cow').type, 'passive');
  assert.equal(results.find(r => r.name === 'item').type, 'item');
});

test('port resolution uses SRV when port is null, 25565, or undefined', () => {
  const resolve = p => (p && Number(p) !== 25565) ? Number(p) : undefined;
  assert.equal(resolve(null), undefined);
  assert.equal(resolve(undefined), undefined);
  assert.equal(resolve(25565), undefined);
  assert.equal(resolve('25565'), undefined);
  assert.equal(resolve(12652), 12652);
  assert.equal(resolve('12652'), 12652);
});

test('storage indexing tracks items and finds item locations', () => {
  const path = require('node:path');
  const fs = require('node:fs');
  const { AIMemory } = require('../lib/ai-memory');

  const testPath = path.resolve(__dirname, '..', 'data', 'test-chest-memory.json');
  try { if (fs.existsSync(testPath)) fs.unlinkSync(testPath); } catch {}

  const mem = new AIMemory(testPath);
  mem.recordChest({ x: 10, y: 64, z: 20 }, [
    { name: 'diamond', count: 12 },
    { name: 'iron_ingot', count: 64 }
  ]);
  mem.recordChest({ x: 50, y: 64, z: -30 }, [
    { name: 'gold_ingot', count: 18 }
  ]);

  const diamonds = mem.findItemInChests('diamond');
  assert.equal(diamonds.length, 1);
  assert.equal(diamonds[0].count, 12);
  assert.equal(diamonds[0].chest.x, 10);

  const missing = mem.findItemInChests('netherite');
  assert.equal(missing.length, 0);

  try { if (fs.existsSync(testPath)) fs.unlinkSync(testPath); } catch {}
});

test('pro AI parses locate, fetch, inspectStorage, buildStructure, and guard intents', () => {
  const { parseLocalIntent, planForIntent } = require('../lib/ai-brain');

  const p1 = parseLocalIntent('locate diamond');
  assert.equal(p1.type, 'locate');
  assert.equal(p1.item, 'diamond');

  const p2 = parseLocalIntent('fetch 5 iron_ingot');
  assert.equal(p2.type, 'fetch');
  assert.equal(p2.count, 5);

  const p3 = parseLocalIntent('scan storage');
  assert.equal(p3.type, 'inspectStorage');

  const p4 = parseLocalIntent('build tower');
  assert.equal(p4.type, 'buildStructure');
  assert.equal(p4.structure, 'tower');

  const p5 = parseLocalIntent('guard me');
  assert.equal(p5.type, 'guard');
  assert.equal(p5.player, 'me');

  const plan = planForIntent(p4);
  assert.deepEqual(plan, [{ skill: 'buildStructure', args: { structure: 'tower' } }]);
});

test('saturation-aware eat prioritizes golden apple when wounded and cooked beef over apple', async () => {
  const { AISkills } = require('../lib/ai-skills');
  const consumed = [];
  const fakeBot = {
    username: 'commotozze',
    health: 8,
    food: 14,
    entity: { position: new Vec3(0, 64, 0) },
    inventory: {
      items: () => [
        { name: 'apple', count: 5 },
        { name: 'cooked_beef', count: 12 },
        { name: 'golden_apple', count: 2 }
      ]
    },
    consume: async () => { consumed.push(fakeBot.heldItem?.name); },
    equip: async (item) => { fakeBot.heldItem = item; }
  };

  const skills = new AISkills({ agent: { runId: 1 }, getBot: () => fakeBot, runId: 1 });
  const res = await skills.eat();
  assert.match(res.message, /golden apple/i);
  assert.equal(consumed[0], 'golden_apple');
});

test('pro AI parses coordinate navigation intents', () => {
  const { parseLocalIntent, planForIntent } = require('../lib/ai-brain');

  const p1 = parseLocalIntent('come 15 42 -10');
  assert.equal(p1.type, 'gotoCoords');
  assert.equal(p1.x, 15);
  assert.equal(p1.y, 42);
  assert.equal(p1.z, -10);

  const p2 = parseLocalIntent('goto -100 64 250');
  assert.equal(p2.type, 'gotoCoords');
  assert.equal(p2.x, -100);
  assert.equal(p2.y, 64);
  assert.equal(p2.z, 250);

  const plan = planForIntent(p1);
  assert.deepEqual(plan, [{ skill: 'gotoCoordinates', args: { x: 15, y: 42, z: -10 } }]);
});
