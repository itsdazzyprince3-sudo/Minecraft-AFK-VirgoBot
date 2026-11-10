'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, createCortex } = require('../lib/ai-cortex');
const { getReasoner } = require('../lib/ai-reasoner');
const { getSkillCatalog } = require('../lib/skill-catalog');

function reasoner() {
  return getReasoner({ catalog: getSkillCatalog() });
}

test('brain assessment orders urgent needs ahead of curiosity', () => {
  const world = assess({
    health: 6,
    food: 4,
    inventory: {},
    nearbyHostiles: [{ name: 'zombie', distance: 5 }],
    time: { isDay: false }
  });
  assert.equal(world.needs[0].kind, 'retreat');
  assert.ok(world.needs.some(need => need.kind === 'food'));
  assert.ok(world.needs.some(need => need.kind === 'shelter'));
});

test('brain deliberation adds survival before a risky task at low health', () => {
  const cortex = createCortex();
  const decision = cortex.deliberate('mine 4 diamond ore', {
    observation: {
      health: 6,
      food: 18,
      inventory: {},
      nearbyHostiles: [{ name: 'zombie', distance: 6 }],
      time: { isDay: true }
    },
    memory: null,
    reasoner: reasoner()
  });
  assert.ok(decision);
  assert.equal(decision.plan.steps[0].skill, 'survive');
  assert.ok(decision.thought.join(' ').includes('Survival outranks'));
  assert.ok(decision.confidence > 0 && decision.confidence <= 1);
});

test('brain autonomy prefers a tool upgrade when no urgent need exists', () => {
  const cortex = createCortex();
  const decision = cortex.recommendAutonomy({
    observation: {
      health: 20,
      food: 20,
      inventory: {
        stone_pickaxe: 1, stone_sword: 1, oak_log: 32, cobblestone: 32,
        coal: 8, torch: 8, iron_ingot: 12
      },
      nearbyHostiles: [],
      time: { isDay: true }
    },
    memory: null,
    config: {},
    reasoner: reasoner(),
    autonomyGoal: 'auto',
    fullAutonomy: true
  });
  assert.equal(decision.kind, 'goal');
  assert.equal(decision.goal.skill, 'ensureItem');
  assert.match(decision.goal.args.item, /pickaxe/);
  assert.ok(decision.thought.join(' ').includes('calm window'));
});

test('bounded autonomy avoids curiosity mining while fullauto mines only supported nearby resources', () => {
  const observation = {
    health: 20,
    food: 20,
    inventory: {
      diamond_pickaxe: 1, iron_sword: 1, oak_log: 32, cobblestone: 32,
      coal: 32, torch: 32
    },
    nearbyHostiles: [],
    time: { isDay: true }
  };
  const cortex = createCortex();
  const bounded = cortex.recommendAutonomy({
    observation, memory: null, config: {}, reasoner: reasoner(), autonomyGoal: 'auto'
  });
  assert.equal(bounded.goal.skill, 'stay');

  const full = cortex.recommendAutonomy({
    observation, memory: null, config: {}, reasoner: reasoner(), autonomyGoal: 'auto', fullAutonomy: true
  });
  if (full.goal.skill === 'mine') {
    assert.ok(['stone', 'coal_ore', 'iron_ore'].includes(full.goal.args.item));
  }
});

test('brain reflection diagnoses route and missing-item failures', () => {
  const facts = {};
  const memory = { setFact: (key, value) => { facts[key] = value; } };
  const cortex = createCortex();
  const decision = { kind: 'goal', goal: { skill: 'mine', reason: 'test' } };
  const route = cortex.replan(decision, new Error('Path was stopped before it could be completed!'), {
    observation: { health: 20, food: 20, inventory: {}, nearbyHostiles: [] },
    memory,
    reasoner: reasoner()
  });
  assert.equal(route.goal.skill, 'explore');
  const missing = cortex.replan(decision, new Error('No iron_pickaxe in my inventory.'), {
    observation: { health: 20, food: 20, inventory: {}, nearbyHostiles: [] },
    memory,
    reasoner: reasoner()
  });
  assert.equal(missing.goal.skill, 'ensureItem');
  assert.equal(missing.goal.args.item, 'iron_pickaxe');
  const reflection = cortex.reflect(decision, { error: new Error('could not find any diamond_ore nearby'), memory });
  assert.equal(reflection.success, false);
  assert.ok(facts['brain:lastLesson'].lesson);
});
