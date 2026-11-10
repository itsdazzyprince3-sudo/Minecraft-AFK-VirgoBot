'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { AIAgent, LOW_HEALTH_THRESHOLD, MAX_INSTRUCTION_LENGTH } = require('../lib/ai-agent');
const { parseGeminiInteraction } = require('../lib/gemini-interactions');

const noOpMemory = {
  getNotes: () => [],
  addNote: () => {}
};

test('AI instructions are validated before starting', () => {
  const agent = new AIAgent({
    config: { enabled: false },
    getBot: () => null,
    isConnected: () => false
  });

  assert.throws(() => agent.start(''), /between 1 and/);
  assert.throws(() => agent.start('x'.repeat(MAX_INSTRUCTION_LENGTH + 1)), /between 1 and/);
  assert.throws(() => agent.start('mine stone'), /disabled/);
});

test('known polite action paraphrases route locally without requiring a model API key', () => {
  const agent = new AIAgent({
    config: { enabled: true, provider: 'openai' },
    getBot: () => ({}),
    isConnected: () => true
  });
  let receivedInstruction = null;
  agent.runLocal = (_runId, instruction) => { receivedInstruction = instruction; };

  assert.doesNotThrow(() => agent.start('Could you please step over to me?', 'commotozze'));
  assert.equal(agent.activeProvider, 'local');
  assert.equal(receivedInstruction, 'Could you please step over to me?');
  assert.match(agent.getStatus().message, /Understanding your request/);
  agent.stop();
});

test('death locations persist with dimension and are restored without crossing dimensions', async () => {
  let saved = null;
  const memory = {
    ...noOpMemory,
    getFact: key => key === 'deathRecovery' ? saved : null,
    setFact: (key, value) => { if (key === 'deathRecovery') saved = value; },
    deleteFact: key => { if (key === 'deathRecovery') saved = null; }
  };
  const bot = {
    entity: { position: new Vec3(4, 65, -2) },
    inventory: { items: () => [{ name: 'oak_log', count: 3 }] },
    game: { dimension: 'overworld' }
  };
  const first = new AIAgent({
    config: { enabled: true, memory: true },
    memory,
    getBot: () => bot,
    isConnected: () => true
  });
  assert.equal(first.recordDeath(), true);
  assert.equal(saved.dimension, 'overworld');
  assert.equal(saved.inventory.oak_log, 3);

  bot.game.dimension = 'the_nether';
  const restarted = new AIAgent({
    config: { enabled: true, memory: true },
    memory,
    getBot: () => bot,
    isConnected: () => true
  });
  assert.equal(restarted.hasDeathRecovery(), true);
  await assert.rejects(restarted.recoverDroppedItems(), /currently in the_nether/);
  assert.equal(restarted.hasDeathRecovery(), true);
});

test('autonomous gathering is opt-in and can be paused and resumed', async () => {
  const agent = new AIAgent({
    config: { enabled: true, autonomous: { enabled: false } },
    getBot: () => null,
    isConnected: () => true,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Request aborted.')), { once: true });
    })
  });
  assert.throws(() => agent.startAutonomous(), /disabled/);

  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  try {
    agent.config.autonomous.enabled = true;
    assert.equal(agent.startAutonomous().status, 'working');
    assert.equal(agent.autonomyActive, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const paused = agent.pauseAutonomous();
    assert.equal(paused.paused, true);
    assert.equal(agent.autonomyActive, false);
    assert.equal(agent.getStatus().status, 'stopped');
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
  }
});

test('local autonomous mode uses the local planner even when a cloud API key is configured', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    provider: process.env.AI_PROVIDER
  };
  process.env.AI_API_KEY = 'test-key';
  delete process.env.AI_PROVIDER;
  const agent = new AIAgent({
    config: {
      enabled: true,
      provider: 'auto',
      autonomous: { enabled: true, mode: 'local', intervalMs: 6000 }
    },
    getBot: () => ({}),
    isConnected: () => true
  });
  let cycles = 0;
  agent.runAutonomyCycle = async () => { cycles += 1; };

  try {
    agent.startAutonomous();
    assert.equal(cycles, 1);
    assert.equal(agent.autonomyActive, true);

    agent.scheduleAutonomousCycle(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(cycles, 2);
  } finally {
    agent.stop();
    if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous.apiKey;
    if (previous.provider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = previous.provider;
  }
});

test('autonomous tasks cannot use non-gathering tools or mine unapproved blocks', async () => {
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => ({}),
    isConnected: () => true
  });
  agent.isAutonomousTask = true;
  await assert.rejects(
    agent.executeTool('craft_item', JSON.stringify({ item: 'oak_planks' })),
    /cannot use the craft_item action/
  );
  await assert.rejects(
    agent.executeTool('mine_block', JSON.stringify({ block: 'diamond_ore' })),
    /limited to/
  );
});

test('autonomous mining never exceeds the per-cycle block limit', async () => {
  const bot = {
    registry: { blocksByName: { stone: { id: 1 } } },
    inventory: { items: () => [] }
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true
  });
  agent.isAutonomousTask = true;
  agent.autonomousBlocksMined = 24;
  const result = await agent.mineBlock(bot, { block: 'stone', count: 8 });
  assert.equal(result.mined, 0);
  assert.match(result.message, /block limit/);
});

test('autonomous mining accepts exposed blocks but rejects blocks under a roof', () => {
  const targetPosition = new Vec3(0, 0, 0);
  const target = {
    name: 'stone',
    id: 1,
    position: targetPosition,
    diggable: true
  };
  let roofHeight = null;
  const bot = {
    entity: { position: new Vec3(0, 0, 2) },
    health: 20,
    entities: {},
    pathfinder: { bestHarvestTool: () => ({ name: 'iron_pickaxe' }) },
    findBlocks: options => {
      if (options.point) return [];
      return [targetPosition];
    },
    blockAt: position => {
      if (position.y === targetPosition.y) return target;
      if (roofHeight === position.y) return { name: 'dirt' };
      return { name: 'air' };
    }
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true
  });

  assert.equal(agent.findSafeAutonomousBlock(bot, 1), target);
  roofHeight = 8;
  assert.equal(agent.findSafeAutonomousBlock(bot, 1), null);
});

test('AI task uses the configured model API and can finish a task', async () => {
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  const bot = { pathfinder: {}, clearControlStates() {} };
  let request;
  const agent = new AIAgent({
    config: { enabled: true, model: 'test-model', apiUrl: 'https://example.test/v1/chat/completions' },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'finish-1',
                type: 'function',
                function: {
                  name: 'finish_task',
                  arguments: JSON.stringify({ message: 'Done.' })
                }
              }]
            }
          }]
        })
      };
    }
  });

  try {
    agent.start('Mine stone.', null, { forceModel: true });
    for (let attempt = 0; attempt < 20 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'Done.');
    assert.equal(request.url, 'https://example.test/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, 'test-model');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /Mine stone\./);
    assert.match(body.messages[0].content, /Reason privately.*Verify the structured game state/s);
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
  }
});

test('AI task uses Gemini Interactions with tool results and chained interactions', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    apiUrl: process.env.AI_API_URL,
    model: process.env.AI_MODEL
  };
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  process.env.AI_MODEL = 'gemini-3.5-flash';
  const requests = [];
  const responses = [
    {
      id: 'interaction-1',
      status: 'requires_action',
      steps: [{
        type: 'function_call',
        id: 'observe-call-1',
        name: 'observe',
        arguments: {}
      }]
    },
    {
      id: 'interaction-2',
      status: 'requires_action',
      steps: [{
        type: 'function_call',
        id: 'finish-call-2',
        name: 'finish_task',
        arguments: { message: 'Done.' }
      }]
    }
  ];
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => ({}),
    isConnected: () => true,
    memory: {
      getNotes: () => ['Always keep oak logs.'],
      addNote: () => {}
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => responses.shift() };
    }
  });
  agent.executeTool = async name => name === 'observe'
    ? { health: 20, inventory: [] }
    : { finished: true, message: 'Done.' };

  try {
    agent.start('Gather wood.', null, { forceModel: true });
    for (let attempt = 0; attempt < 30 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'Done.');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(requests[0].options.headers['x-goog-api-key'], 'test-key');
    assert.equal(requests[0].options.headers.Authorization, undefined);
    const firstBody = JSON.parse(requests[0].options.body);
    assert.equal(firstBody.model, 'gemini-3.5-flash');
    assert.equal(firstBody.input, 'Gather wood.');
    assert.match(firstBody.system_instruction, /You are Virgo/);
    assert.match(firstBody.system_instruction, /Always keep oak logs/);
    assert.deepEqual(firstBody.tools[0], { type: 'google_search' });
    assert.equal(firstBody.tools.find(tool => tool.name === 'observe').type, 'function');

    const secondBody = JSON.parse(requests[1].options.body);
    assert.equal(secondBody.previous_interaction_id, 'interaction-1');
    assert.deepEqual(secondBody.input, [{
      type: 'function_result',
      call_id: 'observe-call-1',
      name: 'observe',
      result: { health: 20, inventory: [] }
    }]);
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous.apiKey;
    if (previous.apiUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previous.apiUrl;
    if (previous.model === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous.model;
  }
});

test('AI task retries temporary Gemini 503 responses with bounded backoff', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    apiUrl: process.env.AI_API_URL,
    model: process.env.AI_MODEL
  };
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  process.env.AI_MODEL = 'gemini-3.5-flash';
  let requestCount = 0;
  const retryDelays = [];
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => ({}),
    isConnected: () => true,
    memory: noOpMemory,
    sleep: async milliseconds => retryDelays.push(milliseconds),
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount < 3) {
        return {
          ok: false,
          status: 503,
          headers: { get: () => '0.5' },
          text: async () => 'Temporarily unavailable'
        };
      }
      return {
        ok: true,
        json: async () => ({
          id: 'interaction-recovered',
          status: 'requires_action',
          steps: [{
            type: 'function_call',
            id: 'finish-recovered',
            name: 'finish_task',
            arguments: { message: 'Done after retry.' }
          }]
        })
      };
    }
  });

  try {
    agent.start('Answer after retry.');
    for (let attempt = 0; attempt < 30 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'Done after retry.');
    assert.equal(requestCount, 3);
    assert.deepEqual(retryDelays, [500, 500]);
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous.apiKey;
    if (previous.apiUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previous.apiUrl;
    if (previous.model === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous.model;
  }
});

test('HTTP 429 pauses autonomous gathering without retrying or scheduling another cycle', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    apiUrl: process.env.AI_API_URL,
    model: process.env.AI_MODEL
  };
  process.env.AI_API_KEY = 'test-key';
  delete process.env.AI_API_URL;
  delete process.env.AI_MODEL;
  let requests = 0;
  const agent = new AIAgent({
    config: {
      enabled: true,
      autonomous: { enabled: true },
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
      model: 'gemini-3.5-flash-lite'
    },
    getBot: () => ({}),
    isConnected: () => true,
    fetchImpl: async () => {
      requests += 1;
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => '{"error":{"message":"You exceeded your current quota"}}'
      };
    }
  });

  try {
    agent.startAutonomous();
    for (let attempt = 0; attempt < 20 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(requests, 1);
    assert.equal(agent.autonomyActive, false);
    assert.equal(agent.isAutonomousTask, false);
    assert.equal(agent.autonomousTimer, null);
    assert.equal(agent.getStatus().status, 'error');
    assert.match(agent.getStatus().message, /HTTP 429.*paused/);
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous.apiKey;
    if (previous.apiUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previous.apiUrl;
    if (previous.model === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous.model;
  }
});

test('AI task reports a clear message when Gemini remains unavailable after retries', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    apiUrl: process.env.AI_API_URL,
    model: process.env.AI_MODEL
  };
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  process.env.AI_MODEL = 'gemini-3.5-flash';
  let requestCount = 0;
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => ({}),
    isConnected: () => true,
    memory: noOpMemory,
    sleep: async () => {},
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: 503,
        text: async () => 'High demand'
      };
    }
  });

  try {
    agent.start('Answer during outage.');
    for (let attempt = 0; attempt < 30 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(requestCount, 3);
    assert.equal(agent.getStatus().status, 'error');
    assert.match(agent.getStatus().message, /temporarily unavailable/);
    assert.match(agent.getStatus().message, /try !ai again/);
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous.apiKey;
    if (previous.apiUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previous.apiUrl;
    if (previous.model === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous.model;
  }
});

test('AI task can answer a question with a plain model response', async () => {
  const previousKey = process.env.AI_API_KEY;
  const previousUrl = process.env.AI_API_URL;
  const previousModel = process.env.AI_MODEL;
  process.env.AI_API_KEY = 'test-key';
  delete process.env.AI_API_URL;
  delete process.env.AI_MODEL;
  const agent = new AIAgent({
    config: { enabled: true, model: 'gemini-3.5-flash-lite' },
    getBot: () => ({}),
    isConnected: () => true,
    memory: noOpMemory,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        id: 'interaction-answer',
        status: 'completed',
        steps: [{
          type: 'model_output',
          content: [{ type: 'text', text: 'You have three logs.' }]
        }]
      })
    })
  });

  try {
    agent.start('How many logs do I have?');
    for (let attempt = 0; attempt < 20 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'You have three logs.');
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previousUrl;
    if (previousModel === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previousModel;
  }
});

test('Gemini text-only interactions are parsed as answers', () => {
  const parsed = parseGeminiInteraction({
    id: 'interaction-answer',
    status: 'completed',
    steps: [{
      type: 'model_output',
      content: [{
        type: 'text',
        text: 'There are three logs.',
        annotations: [{
          type: 'url_citation',
          title: 'Minecraft Wiki',
          url: 'https://minecraft.wiki/w/Log'
        }]
      }]
    }]
  });
  assert.equal(parsed.text, 'There are three logs.');
  assert.deepEqual(parsed.citations, [{
    title: 'Minecraft Wiki',
    url: 'https://minecraft.wiki/w/Log'
  }]);
});

test('Gemini web-grounded answers retain source domains in the response', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    apiUrl: process.env.AI_API_URL,
    model: process.env.AI_MODEL
  };
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  process.env.AI_MODEL = 'gemini-3.8-flash';
  let requestBody;
  const agent = new AIAgent({
    config: { enabled: true, webSearch: true },
    getBot: () => ({}),
    isConnected: () => true,
    memory: noOpMemory,
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          id: 'interaction-web-answer',
          status: 'completed',
          steps: [{
            type: 'model_output',
            content: [{
              type: 'text',
              text: 'The current answer is grounded.',
              annotations: [{
                type: 'url_citation',
                title: 'Example',
                url: 'https://www.example.com/article'
              }]
            }]
          }]
        })
      };
    }
  });

  try {
    agent.start('Search the web for current information.');
    for (let attempt = 0; attempt < 30 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'The current answer is grounded. Sources: example.com.');
    assert.deepEqual(requestBody.tools[0], { type: 'google_search' });
  } finally {
    if (previous.apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previous.apiKey;
    if (previous.apiUrl === undefined) delete process.env.AI_API_URL;
    else process.env.AI_API_URL = previous.apiUrl;
    if (previous.model === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous.model;
  }
});

test('AI task reports model API errors rather than claiming success', async () => {
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => ({}),
    isConnected: () => true,
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized'
    })
  });

  try {
    agent.start('Gather wood.', null, { forceModel: true });
    for (let attempt = 0; attempt < 20 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'error');
    assert.match(agent.getStatus().message, /HTTP 401/);
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
  }
});

test('AI crafts inventory-ready items without requiring a crafting table', async () => {
  const recipe = { requiresTable: false, result: { count: 4 } };
  const craftCalls = [];
  const bot = {
    registry: { itemsByName: { oak_planks: { id: 5 } } },
    recipesFor: (itemId, metadata, count, table) => {
      assert.equal(itemId, 5);
      assert.equal(table, null);
      return [recipe];
    },
    craft: async (...args) => craftCalls.push(args)
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true
  });

  const result = await agent.executeTool('craft_item', JSON.stringify({ item: 'oak_planks', count: 4 }));

  assert.deepEqual(result, { crafted: 'oak_planks', count: 4 });
  assert.deepEqual(craftCalls, [[recipe, 1, null]]);
});

test('stopping an AI task aborts its pending model request', async () => {
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  const bot = { pathfinder: { stop() {} }, clearControlStates() {} };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true,
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Request aborted.')));
    })
  });

  try {
    agent.start('Gather wood.');
    await new Promise(resolve => setTimeout(resolve, 0));
    agent.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(agent.getStatus().status, 'stopped');
  } finally {
    if (previousKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = previousKey;
  }
});

test('survival defense attacks known hostile mobs but never players', () => {
  const zombie = { type: 'mob', name: 'zombie', position: new Vec3(3, 0, 0) };
  const player = { type: 'player', name: 'player', position: new Vec3(1, 0, 0) };
  const attacked = [];
  const bot = {
    entity: { position: new Vec3(0, 0, 0) },
    entities: { zombie, player },
    health: 20,
    attack: entity => attacked.push(entity)
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory
  });

  agent.checkSurvival();
  assert.deepEqual(attacked, [zombie]);

  bot.entities = { player };
  agent.lastDefenseActionAt = 0;
  agent.checkSurvival();
  assert.deepEqual(attacked, [zombie]);
});

test('survival defense retreats from nearby hostiles at the low-health threshold', async () => {
  const goals = [];
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      zombie: { type: 'mob', name: 'zombie', position: new Vec3(2, 64, 0) }
    },
    health: LOW_HEALTH_THRESHOLD,
    pathfinder: { goto: async goal => goals.push(goal) },
    clearControlStates() {}
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory
  });

  agent.checkSurvival();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(goals.length, 1);
  assert.equal(goals[0].x, -12);
  assert.equal(goals[0].rangeSq, 4);
  assert.equal(agent.survivalAction, false);
});

test('survival defense retreats from a nearby creeper instead of attacking it', async () => {
  const goals = [];
  const attacks = [];
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      creeper: { type: 'mob', name: 'creeper', position: new Vec3(4, 64, 0) }
    },
    health: 20,
    pathfinder: { goto: async goal => goals.push(goal) },
    attack: entity => attacks.push(entity),
    clearControlStates() {}
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory
  });

  agent.checkSurvival();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(goals.length, 1);
  assert.deepEqual(attacks, []);
});

test('death recovery returns for missing inventory when the location is safe', async () => {
  let items = [{ name: 'oak_log', count: 3 }];
  const goals = [];
  const bot = {
    entity: { position: new Vec3(1, 64, 0) },
    entities: {},
    health: 20,
    inventory: { items: () => items },
    pathfinder: {
      goto: async goal => {
        goals.push(goal);
        items = [{ name: 'oak_log', count: 3 }];
      }
    }
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory,
    sleep: async () => {}
  });

  agent.recordDeath();
  items = [];
  const result = await agent.recoverDroppedItems();

  assert.equal(goals.length, 1);
  assert.deepEqual(result.recovered, [{ item: 'oak_log', count: 3 }]);
  assert.equal(agent.hasDeathRecovery(), false);
});

test('item delivery is limited to the trusted requester', async () => {
  const tossed = [];
  const recipient = {
    username: 'Virgo',
    entity: { position: new Vec3(2, 64, 0) }
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    players: { Virgo: recipient, OtherPlayer: { username: 'OtherPlayer', entity: recipient.entity } },
    registry: { itemsByName: { oak_log: { id: 1 } } },
    inventory: { items: () => [{ name: 'oak_log', count: 5 }] },
    pathfinder: { goto: async () => {} },
    toss: async (...args) => tossed.push(args)
  };
  const agent = new AIAgent({
    config: { enabled: true },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory
  });
  agent.requestedBy = 'Virgo';

  const result = await agent.executeTool('deliver_item', JSON.stringify({ item: 'oak_log', count: 2 }));
  assert.deepEqual(result, { delivered: 'oak_log', count: 2, recipient: 'Virgo' });
  assert.deepEqual(tossed, [[1, null, 2]]);

  agent.requestedBy = null;
  await assert.rejects(
    agent.executeTool('deliver_item', JSON.stringify({ item: 'oak_log' })),
    /trusted player/
  );
});


test('auto provider falls back to local Ollama and answers without a cloud API key', async () => {
  const previous = {
    apiKey: process.env.AI_API_KEY,
    provider: process.env.AI_PROVIDER,
    model: process.env.AI_MODEL,
    url: process.env.OLLAMA_URL,
    ollamaModel: process.env.OLLAMA_MODEL
  };
  delete process.env.AI_API_KEY;
  delete process.env.AI_PROVIDER;
  delete process.env.AI_MODEL;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_MODEL;
  const requests = [];
  const bot = {
    username: 'commotozze',
    entity: { position: new Vec3(3, 64, -4) },
    health: 20,
    food: 20,
    oxygenLevel: 300,
    time: { timeOfDay: 1000, day: 2, isDay: true },
    inventory: { items: () => [] },
    findBlocks: () => [],
    blockAt: () => null,
    entities: {},
    players: {}
  };
  const agent = new AIAgent({
    config: {
      enabled: true,
      provider: 'auto',
      ollama: { enabled: true, url: 'http://127.0.0.1:11434/api/chat', model: 'qwen2.5:1.5b' }
    },
    getBot: () => bot,
    isConnected: () => true,
    memory: noOpMemory,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ message: { content: 'Hello! I am ready.' } }) };
    }
  });

  try {
    assert.equal(agent.resolveProvider(), 'local');
    agent.start('How should I prepare my village for a snowstorm?', 'virgo');
    for (let attempt = 0; attempt < 50 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'Hello! I am ready.');
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(JSON.parse(requests[0].options.body).model, 'qwen2.5:1.5b');
  } finally {
    for (const [key, value] of Object.entries({
      AI_API_KEY: previous.apiKey,
      AI_PROVIDER: previous.provider,
      AI_MODEL: previous.model,
      OLLAMA_URL: previous.url,
      OLLAMA_MODEL: previous.ollamaModel
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('local web search is opt-in, bounded, and rejects non-HTTPS result links', async () => {
  const priorKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'test-search-key';
  try {
    let called = false;
    const agent = new AIAgent({
      config: { enabled: true, search: { enabled: true, maxResults: 2 } },
      getBot: () => null,
      isConnected: () => false,
      fetchImpl: async (url, options) => {
        called = true;
        assert.equal(url, 'https://api.tavily.com/search');
        assert.equal(options.headers.Authorization, 'Bearer test-search-key');
        assert.equal(JSON.parse(options.body).max_results, 2);
        return { ok: true, json: async () => ({ results: [
          { title: 'Current result', url: 'https://example.com/page', content: 'Evidence' },
          { title: 'Unsafe', url: 'http://example.com/', content: 'Discard this' }
        ] }) };
      }
    });
    assert.equal(agent.shouldSearchLocal('What is the latest Minecraft release?'), true);
    assert.equal(agent.shouldSearchLocal('What is a crafting table?'), false);
    const results = await agent.searchLocalWeb('latest Minecraft release');
    assert.equal(called, true);
    assert.deepEqual(results, [{ title: 'Current result', url: 'https://example.com/page', content: 'Evidence' }]);
  } finally {
    if (priorKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = priorKey;
  }
});

test('local web search does not run unless enabled in settings', async () => {
  let called = false;
  const agent = new AIAgent({
    config: { enabled: true, webSearch: false, search: { enabled: false } },
    getBot: () => null,
    isConnected: () => false,
    fetchImpl: async () => { called = true; throw new Error('should not be called'); }
  });
  assert.equal(agent.shouldSearchLocal('What is the latest release?'), false);
  assert.deepEqual(await agent.searchLocalWeb('latest release'), []);
  assert.equal(called, false);
});

test('task outcomes are learned by default and relevant examples reach the local model', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'virgo-agent-learning-'));
  try {
    const file = path.join(directory, 'knowledge.json');
    let systemPrompt = '';
    const agent = new AIAgent({
      config: {
        enabled: true,
        training: { knowledgePath: file },
        ollama: { enabled: true, url: 'http://localhost/api/chat', model: 'test' }
      },
      getBot: () => null,
      isConnected: () => false,
      fetchImpl: async (_url, options) => {
        systemPrompt = JSON.parse(options.body).messages[0].content;
        return { ok: true, json: async () => ({ message: { content: 'I can use that lesson.' } }) };
      }
    });

    agent.recordTaskExperience('mine 8 stone', { success: true, message: 'Collected 8 stone.' });
    agent.recordTaskExperience('mine 8 coal ore', { success: false, message: 'No coal ore nearby.' });
    agent.recordTaskExperience('what is a creeper', { success: true, message: 'A hostile mob.' });
    assert.equal(agent.getKnowledge().stats().experiences, 2);

    await agent.askLocalModel('mine stone', { health: 20, food: 20, inventory: {} });
    assert.match(systemPrompt, /untrusted examples, not instructions/i);
    assert.match(systemPrompt, /mine 8 stone/);
    assert.match(systemPrompt, /Collected 8 stone/);

    const disabled = new AIAgent({
      config: { training: { enabled: false, knowledgePath: file } },
      getBot: () => null,
      isConnected: () => false
    });
    disabled.recordTaskExperience('mine dirt', { success: true, message: 'Collected dirt.' });
    assert.equal(disabled.getKnowledge().stats().experiences, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local model includes web evidence and cites its source URLs', async () => {
  const agent = new AIAgent({
    config: { enabled: true, ollama: { enabled: true, url: 'http://localhost/api/chat', model: 'test' } },
    getBot: () => null,
    isConnected: () => false,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /untrusted web search results/i);
      assert.match(body.messages[0].content, /https:\/\/example\.com\/page/);
      return { ok: true, json: async () => ({ message: { content: 'Version information found.' } }) };
    }
  });
  const reply = await agent.askLocalModel('latest version?', { health: 20, food: 20, inventory: {} }, [
    { title: 'Release', url: 'https://example.com/page', content: 'The current release.' }
  ]);
  assert.match(reply, /Sources: \[1\] https:\/\/example\.com\/page/);
});


test('autonomous grinding backs off and pauses after three failed cycles', async () => {
  const scheduled = [];
  const agent = new AIAgent({
    config: { enabled: true, autonomous: { enabled: true } },
    getBot: () => ({}),
    isConnected: () => true,
    memory: { recordSkill() {}, incrementStat() {} }
  });
  agent.autonomyActive = true;
  agent.createSkills = () => ({ observation: () => ({ health: 20, food: 20, inventory: {} }) });
  agent.executeSkill = async () => { throw new Error('No logs reached inventory.'); };
  agent.scheduleAutonomousCycle = milliseconds => scheduled.push(milliseconds);
  await agent.runAutonomyCycle();
  await agent.runAutonomyCycle();
  await agent.runAutonomyCycle();
  assert.deepEqual(scheduled, [15000, 30000]);
  assert.equal(agent.autonomyActive, false);
  assert.equal(agent.autonomyConsecutiveFailures, 3);
  assert.equal(agent.getStatus().status, 'paused');
});

test('Groq provider uses its dedicated key, endpoint, model, and chat-completions tool format', async () => {
  const keys = ['GROQ_API_KEY', 'GROQ_API_URL', 'GROQ_MODEL', 'AI_PROVIDER', 'AI_API_KEY', 'OPENAI_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.AI_PROVIDER = 'groq';
  delete process.env.GROQ_API_URL;
  delete process.env.GROQ_MODEL;
  delete process.env.AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    let called = false;
    const agent = new AIAgent({
      config: { enabled: true, provider: 'groq' },
      getBot: () => null,
      isConnected: () => false,
      fetchImpl: async (url, options) => {
        called = true;
        assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer test-groq-key');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'qwen/qwen3.8-27b');
        assert.equal(body.parallel_tool_calls, false);
        assert.ok(Array.isArray(body.tools));
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Groq works.' } }] }) };
      }
    });
    assert.equal(agent.resolveProvider(), 'groq');
    assert.equal(agent.modelEndpoint(), 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(agent.modelName(), 'qwen/qwen3.8-27b');
    assert.equal(agent.modelApiKey(), 'test-groq-key');
    const response = await agent.requestModel([{ role: 'user', content: 'Hello' }]);
    assert.equal(called, true);
    assert.equal(response.choices[0].message.content, 'Groq works.');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('auto provider selects Groq when its dedicated key is configured', () => {
  const keys = ['GROQ_API_KEY', 'AI_PROVIDER', 'LUNAX_API_KEY', 'MODEL_API_KEY', 'OPENAI_API_KEY', 'AI_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.GROQ_API_KEY = 'test-groq-key';
  delete process.env.AI_PROVIDER;
  delete process.env.LUNAX_API_KEY;
  delete process.env.MODEL_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    const agent = new AIAgent({ config: { enabled: true, provider: 'auto' }, getBot: () => null, isConnected: () => false });
    assert.equal(agent.resolveProvider(), 'groq');
    assert.equal(agent.modelApiKey(), 'test-groq-key');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Lunax provider sends OpenAI-compatible chat-completions requests', async () => {
  const keys = ['LUNAX_API_KEY', 'LUNAX_API_URL', 'LUNAX_MODEL', 'AI_PROVIDER', 'MODEL_API_KEY', 'OPENAI_API_KEY', 'AI_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.LUNAX_API_KEY = 'test-lunax-key';
  process.env.AI_PROVIDER = 'lunax';
  delete process.env.LUNAX_API_URL;
  delete process.env.LUNAX_MODEL;
  delete process.env.MODEL_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    const agent = new AIAgent({ config: { enabled: true, provider: 'lunax' }, getBot: () => null, isConnected: () => false,
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://lunax.co/api/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer test-lunax-key');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'lunax-chat');
        assert.equal(body.messages[0].content, 'Hello');
        assert.equal(body.tools, undefined);
        assert.equal(body.tool_choice, undefined);
        assert.equal(body.max_tokens, 512);
        assert.equal(body.stream, false);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hi!' } }] }) };
      }
    });
    assert.equal(agent.resolveProvider(), 'lunax');
    const response = await agent.requestModel([{ role: 'user', content: 'Hello' }]);
    assert.equal(response.choices[0].message.content, 'Hi!');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Lunax JSON actions run through local tools and receive actual results', async () => {
  const keys = ['LUNAX_API_KEY', 'LUNAX_API_URL', 'LUNAX_MODEL', 'AI_PROVIDER'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.LUNAX_API_KEY = 'test-lunax-key';
  process.env.AI_PROVIDER = 'lunax';
  delete process.env.LUNAX_API_URL;
  delete process.env.LUNAX_MODEL;
  try {
    const requests = [];
    const responses = [
      { choices: [{ message: { content: '{"action":"observe","arguments":{}}' } }] },
      { choices: [{ message: { content: '{"action":"finish_task","arguments":{"message":"Done after checking state."}}' } }] }
    ];
    const agent = new AIAgent({
      config: { enabled: true, provider: 'lunax' },
      getBot: () => ({}),
      isConnected: () => true,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(url, 'https://lunax.co/api/v1/chat/completions');
        assert.equal(body.tools, undefined);
        requests.push(body);
        return { ok: true, json: async () => responses.shift() };
      }
    });
    const executed = [];
    agent.executeTool = async (name, rawArgs) => {
      executed.push({ name, args: JSON.parse(rawArgs) });
      return name === 'observe'
        ? { health: 20, inventory: [{ name: 'oak_log', count: 2 }] }
        : { finished: true, message: 'Done after checking state.' };
    };
    agent.start('Inspect then finish.');
    for (let attempt = 0; attempt < 30 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'Done after checking state.');
    assert.deepEqual(executed.map(call => call.name), ['observe', 'finish_task']);
    assert.match(requests[0].messages[0].content, /Available local actions and argument schemas/);
    assert.match(requests[1].messages.at(-1).content, /Actual result from observe.*oak_log/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('auto provider selects Lunax when its API key is configured', () => {
  const keys = ['LUNAX_API_KEY', 'MODEL_API_KEY', 'OPENAI_API_KEY', 'AI_API_KEY', 'AI_PROVIDER'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.LUNAX_API_KEY = 'test-lunax-key';
  delete process.env.MODEL_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_KEY;
  delete process.env.AI_PROVIDER;
  try {
    const agent = new AIAgent({ config: { enabled: true, provider: 'auto' }, getBot: () => null, isConnected: () => false });
    assert.equal(agent.resolveProvider(), 'lunax');
    assert.equal(agent.modelName(), 'lunax-chat');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Meta Responses provider chains bounded Minecraft tool calls', async () => {
  const keys = ['MODEL_API_KEY', 'META_API_URL', 'META_MODEL', 'META_REASONING_EFFORT', 'AI_PROVIDER', 'OPENAI_API_KEY', 'AI_API_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.MODEL_API_KEY = 'test-meta-key';
  process.env.AI_PROVIDER = 'meta';
  delete process.env.META_API_URL;
  delete process.env.META_MODEL;
  delete process.env.META_REASONING_EFFORT;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    const requests = [];
    const responses = [
      { id: 'resp-1', output: [{ type: 'function_call', call_id: 'call-observe', name: 'observe', arguments: '{}' }] },
      { id: 'resp-2', output: [{ type: 'function_call', call_id: 'call-finish', name: 'finish_task', arguments: '{"message":"Done."}' }] }
    ];
    const agent = new AIAgent({
      config: { enabled: true, provider: 'meta', meta: { model: 'muse-wonder-1.0', reasoningEffort: 'medium' } },
      getBot: () => ({}),
      isConnected: () => true,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => responses.shift() };
      }
    });
    agent.executeTool = async name => name === 'observe'
      ? { health: 20, inventory: [] }
      : { finished: true, message: 'Done.' };
    agent.start('Inspect the nearby area.');
    for (let attempt = 0; attempt < 30 && agent.getStatus().status === 'working'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(agent.getStatus().status, 'completed');
    assert.equal(agent.getStatus().message, 'Done.');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.meta.ai/v1/responses');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer test-meta-key');
    const first = JSON.parse(requests[0].options.body);
    assert.equal(first.model, 'muse-wonder-1.0');
    assert.equal(first.reasoning.effort, 'medium');
    assert.match(first.instructions, /You are Virgo/);
    assert.ok(first.tools.some(tool => tool.name === 'observe' && tool.type === 'function'));
    assert.equal(first.input, 'Inspect the nearby area.');
    const second = JSON.parse(requests[1].options.body);
    assert.equal(second.previous_response_id, 'resp-1');
    assert.deepEqual(second.input, [{ type: 'function_call_output', call_id: 'call-observe', output: JSON.stringify({ health: 20, inventory: [] }) }]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenAI provider selects its own endpoint and sends bounded reasoning settings', async () => {
  const previous = Object.fromEntries(['AI_API_KEY', 'OPENAI_API_KEY', 'AI_API_URL', 'OPENAI_API_URL', 'AI_MODEL', 'OPENAI_MODEL', 'AI_REASONING_EFFORT', 'OPENAI_REASONING_EFFORT', 'AI_PROVIDER'].map(key => [key, process.env[key]]));
  process.env.AI_API_KEY = 'test-openai-key';
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_API_URL;
  delete process.env.OPENAI_API_URL;
  delete process.env.AI_MODEL;
  delete process.env.OPENAI_MODEL;
  delete process.env.AI_REASONING_EFFORT;
  delete process.env.OPENAI_REASONING_EFFORT;
  delete process.env.AI_PROVIDER;
  try {
    let called = false;
    const agent = new AIAgent({
      config: {
        enabled: true,
        provider: 'openai',
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        openai: { model: 'gpt-5.5', reasoningEffort: 'medium' }
      },
      getBot: () => null,
      isConnected: () => false,
      fetchImpl: async (url, options) => {
        called = true;
        assert.equal(url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer test-openai-key');
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-5.5');
        assert.equal(body.reasoning_effort, 'medium');
        assert.ok(Array.isArray(body.tools));
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Plan ready.' } }] }) };
      }
    });
    assert.equal(agent.resolveProvider(), 'openai');
    assert.equal(agent.modelEndpoint(), 'https://api.openai.com/v1/chat/completions');
    const response = await agent.requestModel([{ role: 'user', content: 'prepare safely' }]);
    assert.equal(called, true);
    assert.equal(response.choices[0].message.content, 'Plan ready.');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('OpenAI reasoning effort rejects unknown values and uses a fast safe default', () => {
  const agent = new AIAgent({
    config: { enabled: true, provider: 'openai', openai: { reasoningEffort: 'instant' } },
    getBot: () => null,
    isConnected: () => false
  });
  assert.equal(agent.reasoningEffort(), 'low');
});


test('auto provider prefers a separate OpenAI key over a configured Gemini fallback', () => {
  const previous = Object.fromEntries(['OPENAI_API_KEY', 'AI_API_KEY', 'AI_PROVIDER', 'AI_API_URL'].map(key => [key, process.env[key]]));
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.AI_API_KEY = 'test-gemini-key';
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_URL;
  try {
    const agent = new AIAgent({
      config: { enabled: true, provider: 'auto', apiUrl: 'https://generativelanguage.googleapis.com/v1beta/interactions' },
      getBot: () => null,
      isConnected: () => false
    });
    assert.equal(agent.resolveProvider(), 'openai');
    assert.equal(agent.modelEndpoint(), 'https://api.openai.com/v1/chat/completions');
    assert.equal(agent.modelName(), 'gpt-5.5');
    assert.equal(agent.modelApiKey(), 'test-openai-key');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('local web search falls back to the built-in wiki trainer without Tavily', async () => {
  const results = await (async () => {
    const agent = new AIAgent({
      config: {
        enabled: true,
        webSearch: true,
        search: { enabled: false },
        training: { knowledgePath: `${require('node:os').tmpdir()}/virgo-agent-knowledge-${process.pid}.json` }
      },
      getBot: () => null,
      isConnected: () => false,
      fetchImpl: async url => {
        const target = String(url);
        if (target.includes('minecraft.wiki') && target.includes('list=search')) {
          return { ok: true, json: async () => ({ query: { search: [{ title: 'Creeper', snippet: 'Creeper is a hostile mob.' }] } }) };
        }
        if (target.includes('minecraft.wiki') && target.includes('prop=extracts')) {
          return { ok: true, json: async () => ({ query: { pages: { 1: { extract: 'A creeper is a hostile mob that explodes near players.' } } } }) };
        }
        return { ok: false, json: async () => ({}) };
      }
    });
    assert.equal(agent.shouldSearchLocal('What is the latest Minecraft release?'), true);
    return agent.searchLocalWeb('creeper behavior');
  })();
  assert.equal(results[0].title, 'Creeper');
  assert.match(results[0].content, /hostile mob/);
});

test('local recognition command reports recognized resources and threats', async () => {
  const agent = new AIAgent({
    config: {
      enabled: true,
      training: { knowledgePath: `${require('node:os').tmpdir()}/virgo-recognition-knowledge-${process.pid}.json` }
    },
    getBot: () => ({}),
    isConnected: () => true,
    memory: noOpMemory
  });
  agent.createSkills = () => ({
    observation: () => ({
      health: 18,
      food: 20,
      inventory: { stone_pickaxe: 1 },
      nearbyBlocks: [{ name: 'iron_ore', distance: 4 }, { name: 'lava', distance: 6 }],
      nearbyHostiles: [{ name: 'zombie', distance: 14 }],
      nearbyEntities: [],
      players: {},
      time: { isDay: true }
    })
  });
  agent.start('recognize');
  for (let attempt = 0; attempt < 40 && agent.getStatus().status === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(agent.getStatus().status, 'completed');
  assert.match(agent.getStatus().message, /I recognize/);
  assert.match(agent.getStatus().message, /iron_ore/);
  assert.match(agent.getStatus().message, /zombie/);
});

test('local neural model commands report status, evaluate observations, and train', async () => {
  const agent = new AIAgent({
    config: {
      enabled: true,
      training: { knowledgePath: `${require('node:os').tmpdir()}/virgo-model-knowledge-${process.pid}.json` }
    },
    getBot: () => ({}),
    isConnected: () => true,
    memory: noOpMemory
  });
  agent.createSkills = () => ({
    observation: () => ({
      health: 20,
      food: 20,
      inventory: { oak_log: 8 },
      nearbyBlocks: [],
      nearbyHostiles: [],
      nearbyEntities: [],
      players: {},
      time: { isDay: true }
    })
  });

  // 1. Model status
  agent.start('model status');
  for (let attempt = 0; attempt < 40 && agent.getStatus().status === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(agent.getStatus().status, 'completed');
  assert.match(agent.getStatus().message, /Neural Model Status/);

  // 2. Model evaluation
  agent.start('model eval');
  for (let attempt = 0; attempt < 40 && agent.getStatus().status === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(agent.getStatus().status, 'completed');
  assert.match(agent.getStatus().message, /Neural Policy Evaluation/);

  // 3. Model training
  agent.start('model train 2');
  for (let attempt = 0; attempt < 40 && agent.getStatus().status === 'working'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(agent.getStatus().status, 'completed');
  assert.match(agent.getStatus().message, /Trained full stack AI model for 2 epochs/);
});
