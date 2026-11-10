'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  answerKnownQuestion,
  chooseGoal,
  canonicalItem,
  extractItem,
  parseLocalIntent,
  planForIntent,
  recipeAnswer
} = require('../lib/ai-brain');

test('local intent parser maps common Minecraft chat tasks to bounded skills', () => {
  assert.deepEqual(parseLocalIntent('come'), { type: 'come', player: 'requester', raw: 'come' });
  assert.deepEqual(parseLocalIntent('Could you please step over to me?'), {
    type: 'come', player: 'requester', raw: 'Could you please step over to me?'
  });
  assert.deepEqual(parseLocalIntent('Walk over to Virgo'), {
    type: 'come', player: 'virgo', raw: 'Walk over to Virgo'
  });
  assert.deepEqual(parseLocalIntent('mine 8 stone'), {
    type: 'mine', item: 'stone', count: 8, raw: 'mine 8 stone'
  });
  assert.deepEqual(parseLocalIntent('I need you to break 8 blocks of stone for me'), {
    type: 'mine', item: 'stone', count: 8, raw: 'I need you to break 8 blocks of stone for me'
  });
  assert.deepEqual(parseLocalIntent('craft wooden_pickaxe'), {
    type: 'craft', item: 'wooden_pickaxe', count: 1, raw: 'craft wooden_pickaxe'
  });
  assert.deepEqual(parseLocalIntent('open the door'), { type: 'use', target: 'door', raw: 'open the door' });
  assert.equal(parseLocalIntent('use nearest gate').target, 'door');
  assert.deepEqual(parseLocalIntent('tarun ko wood do'), {
    type: 'deliver', item: 'oak_log', count: 8, player: 'tarun', raw: 'tarun ko wood do'
  });
  assert.deepEqual(parseLocalIntent('give 4 oak logs to Tarun'), {
    type: 'deliver', item: 'oak_log', count: 4, player: 'tarun', raw: 'give 4 oak logs to Tarun'
  });
  assert.deepEqual(planForIntent(parseLocalIntent('tarun ko wood do'))[0], {
    skill: 'deliverToPlayer', args: { item: 'oak_log', count: 8, player: 'tarun' }
  });
  assert.equal(parseLocalIntent('follow me').type, 'follow');
  assert.deepEqual(parseLocalIntent('grind wood').goal, 'wood');
  assert.equal(planForIntent(parseLocalIntent('come'))[0].skill, 'comeToPlayer');
});

test('item aliases, quantities, and recipes resolve to Minecraft names', () => {
  assert.equal(extractItem('mine eight cobblestone blocks'), 'cobblestone');
  assert.equal(canonicalItem('iron pickaxes'), 'iron_pickaxe');
  assert.equal(canonicalItem('cherry_planks'), 'cherry_planks');
  assert.equal(canonicalItem('wheat_seeds'), 'wheat_seeds');
  assert.match(recipeAnswer('wooden_pickaxe'), /planks.*sticks/i);
});

test('player attack requests do not become player targets in combat skills', () => {
  assert.deepEqual(parseLocalIntent('attack virgo').target, 'virgo');
  const plan = planForIntent(parseLocalIntent('attack virgo'));
  assert.deepEqual(plan, [{ skill: 'attackNearest', args: { target: 'virgo' } }]);
});

test('known Minecraft questions use concise deterministic answers', () => {
  assert.match(answerKnownQuestion('what is nearby', {
    nearbyBlocks: [{ name: 'oak_log', distance: 4 }],
    nearbyHostiles: []
  }), /oak_log \(4m\)/);
  assert.match(answerKnownQuestion('what is a creeper'), /explode/i);
});


test('autonomous planner explores after a recent unreachable wood route', () => {
  const memory = { getSkill: name => name === 'goal:gatherWood' ? {
    failures: 2,
    lastDetail: 'I could not find reachable logs nearby, even after scouting.',
    lastUsedAt: new Date().toISOString()
  } : null };
  const goal = chooseGoal({
    health: 20,
    food: 20,
    inventory: {},
    nearbyBlocks: []
  }, memory);
  assert.equal(goal.skill, 'explore');
  assert.match(goal.reason, /wood route failed recently/i);
});

test('autonomous planner learns to avoid a recently unreachable mining route', () => {
  const memory = { getSkill: name => name === 'goal:mine' ? {
    failures: 1,
    lastDetail: 'I could not find reachable stone within 32 blocks.',
    lastUsedAt: new Date().toISOString()
  } : null };
  const goal = chooseGoal({
    health: 20,
    food: 20,
    inventory: { wooden_pickaxe: 1 },
    nearbyBlocks: []
  }, memory);
  assert.equal(goal.skill, 'explore');
  assert.match(goal.reason, /failed recently/i);
});

test('autonomous planner sleeps only at night when a bed is available and the area is safe', () => {
  const memory = { getSkill: () => null, getNotes: () => [] };
  const safeNight = chooseGoal({
    health: 20,
    food: 20,
    inventory: { white_bed: 1 },
    time: { isDay: false },
    nearbyHostiles: []
  }, memory);
  assert.equal(safeNight.skill, 'sleep');

  const daytime = chooseGoal({
    health: 20,
    food: 20,
    inventory: { white_bed: 1 },
    time: { isDay: true },
    nearbyHostiles: []
  }, memory);
  assert.notEqual(daytime.skill, 'sleep');

  const unsafeNight = chooseGoal({
    health: 20,
    food: 20,
    inventory: { white_bed: 1 },
    time: { isDay: false },
    nearbyHostiles: [{ name: 'zombie', distance: 4 }]
  }, memory);
  assert.notEqual(unsafeNight.skill, 'sleep');
});

test('explicit wood-grind goals override the automatic failure cooldown', () => {
  const memory = { getSkill: name => name === 'goal:gatherWood' ? {
    failures: 1,
    lastDetail: 'I could not find reachable logs nearby, even after scouting.',
    lastUsedAt: new Date().toISOString()
  } : null };
  const goal = chooseGoal({
    health: 20,
    food: 20,
    inventory: {},
    nearbyBlocks: []
  }, memory, { goal: 'wood' });
  assert.equal(goal.skill, 'gatherWood');
  assert.match(goal.reason, /requested wood grind/i);
});


test('memory inspection and erase phrases map to explicit local commands', () => {
  assert.equal(parseLocalIntent('memory').type, 'memory');
  assert.equal(parseLocalIntent('what have you learned').type, 'memory');
  assert.equal(parseLocalIntent('forget all').type, 'forgetAll');
  assert.equal(parseLocalIntent('clear everything').type, 'forgetAll');
});

test('goal phrases route to hunting, breeding, and reasoned set planning', () => {
  assert.deepEqual(
    (({ type, target, count }) => ({ type, target, count }))(parseLocalIntent('hunt zombies')),
    { type: 'hunt', target: 'zombie', count: 1 }
  );
  assert.equal(parseLocalIntent('kill skeletons').target, 'skeleton');
  assert.deepEqual(
    (({ type, target, count }) => ({ type, target, count }))(parseLocalIntent('feed cows')),
    { type: 'breed', target: 'cow', count: 2 }
  );
  assert.equal(parseLocalIntent('make me a full iron armor set').type, 'solve');
  assert.equal(parseLocalIntent('full diamond tool set').type, 'solve');
  assert.equal(parseLocalIntent('skill mine:diamond_ore 4').type, 'skill');
  assert.equal(parseLocalIntent('skills pickaxe').type, 'skills');
});

test('brain inspection and reasoning phrases route locally', () => {
  assert.equal(parseLocalIntent('brain').type, 'brain');
  assert.equal(parseLocalIntent('what are you thinking').type, 'brain');
  assert.equal(parseLocalIntent('why').type, 'why');
  assert.equal(parseLocalIntent('why did you do that').type, 'why');
  assert.equal(parseLocalIntent('explain your reasoning').type, 'why');
});

test('new physical skills parse from natural phrases', () => {
  assert.equal(parseLocalIntent('tunnel 16').type, 'stripMine');
  assert.equal(parseLocalIntent('tunnel 16').length, 16);
  assert.equal(parseLocalIntent('strip mine 8').type, 'stripMine');
  assert.equal(parseLocalIntent('fish').type, 'fish');
  assert.equal(parseLocalIntent('go fishing').type, 'fish');
  assert.deepEqual(
    (({ item, count }) => ({ item, count }))(parseLocalIntent('withdraw 8 iron_ingot')),
    { item: 'iron_ingot', count: 8 }
  );
  assert.deepEqual(
    (({ item, count }) => ({ item, count }))(parseLocalIntent('take 4 diamond from chest')),
    { item: 'diamond', count: 4 }
  );
  assert.equal(parseLocalIntent('drop').type, 'drop');
  assert.equal(parseLocalIntent('drop 1 diamond').item, 'diamond');
  assert.equal(parseLocalIntent('toss item').type, 'drop');
  assert.equal(parseLocalIntent('look at me').type, 'look');
  assert.equal(parseLocalIntent('look up').type, 'look');
  assert.equal(parseLocalIntent('slot 3').type, 'slot');
  assert.equal(parseLocalIntent('slot 3').slot, 3);
  assert.equal(parseLocalIntent('swing').type, 'swing');
  assert.equal(parseLocalIntent('use').type, 'use');
});

test('recognition, research, knowledge, and training phrases route locally', () => {
  assert.equal(parseLocalIntent('recognize').type, 'recognize');
  assert.equal(parseLocalIntent('what do you see').type, 'recognize');
  assert.equal(parseLocalIntent('research creeper').type, 'research');
  assert.equal(parseLocalIntent('learn about diamond ore').type, 'research');
  assert.equal(parseLocalIntent('train on nether portal').topic, 'nether portal');
  assert.equal(parseLocalIntent('what do you know about creeper').type, 'knowledge');
  assert.equal(parseLocalIntent('tell me about iron ore').query, 'iron ore');
  assert.equal(parseLocalIntent('train').type, 'train');
  assert.equal(parseLocalIntent('train 5 cycles').iterations, 5);
  assert.equal(parseLocalIntent('stop training').action, 'stop');
  assert.equal(parseLocalIntent('train status').action, 'status');
  assert.equal(parseLocalIntent('Search the web for current information.').type, 'chat');
  assert.equal(parseLocalIntent('train creeper').type, 'research');
  assert.equal(parseLocalIntent('train creeper').topic, 'creeper');
  assert.equal(parseLocalIntent('train on creeper').type, 'research');
  assert.equal(parseLocalIntent('train on creeper').topic, 'creeper');
  assert.equal(parseLocalIntent('train 10 hours').type, 'train');
  assert.equal(parseLocalIntent('train 10 hours').durationMs, 36000000);
  assert.equal(parseLocalIntent('train for 30 minutes').durationMs, 1800000);
  assert.equal(parseLocalIntent('train 5').iterations, 5);
});

test('conversational AI engine answers identity, math, jokes, and lore', () => {
  const observation = { health: 20, food: 20, position: { x: 10, y: 64, z: 20 } };

  // Identity & capabilities
  assert.match(answerKnownQuestion('who are you', observation), /Virgo/i);
  assert.match(answerKnownQuestion('who made you', observation), /Lamgerr/i);
  assert.match(answerKnownQuestion('what can you do', observation), /mine/i);
  assert.match(answerKnownQuestion('are you an ai', observation), /AI/i);

  // Math & stacks
  assert.match(answerKnownQuestion('how many is 4 stacks', observation), /256 items/i);
  assert.match(answerKnownQuestion('what is 64 * 3', observation), /192/);

  // Jokes
  assert.ok(answerKnownQuestion('tell me a joke', observation).length > 10);

  // Advanced lore
  assert.match(answerKnownQuestion('what is the warden', observation), /Deep Dark/i);
  assert.match(answerKnownQuestion('how do i beat the wither', observation), /Nether Star/i);
  assert.match(answerKnownQuestion('how do i get an elytra', observation), /End Ship/i);
  assert.match(answerKnownQuestion('what does mending do', observation), /XP orbs/i);
});

test('chat authorization and natural command parsing support all players', () => {
  const { isAIChatAuthorized, parseAIChatCommand } = require('../lib/ai-chat');

  // Wildcard allowlist authorizes all players, configured list authorizes matched
  assert.equal(isAIChatAuthorized('Player123', ['*']), true);
  assert.equal(isAIChatAuthorized('Virgo', ['virgo']), true);

  // Natural chat prefixes
  assert.equal(parseAIChatCommand('!ai what is a creeper').text, 'what is a creeper');
  assert.equal(parseAIChatCommand('virgo come to me').text, 'come to me');
  assert.equal(parseAIChatCommand('hey virgo, mine 10 stone').text, 'mine 10 stone');
  assert.equal(parseAIChatCommand('bot: tell me a joke').text, 'tell me a joke');
});

test('sortChests parses natural intents and plans appropriate action', () => {
  const p1 = parseLocalIntent('sort chests');
  assert.equal(p1.type, 'sortChests');
  assert.equal(p1.category, 'all');

  const p2 = parseLocalIntent('organize inventory ores');
  assert.equal(p2.type, 'sortChests');
  assert.equal(p2.category, 'ores');

  const p3 = parseLocalIntent('deposit crops');
  assert.equal(p3.type, 'sortChests');
  assert.equal(p3.category, 'crops');

  const p4 = parseLocalIntent('store all');
  assert.equal(p4.type, 'sortChests');

  const plan = planForIntent({ type: 'sortChests', category: 'ores' });
  assert.deepEqual(plan, [{ skill: 'sortChests', args: { category: 'ores' } }]);
});
