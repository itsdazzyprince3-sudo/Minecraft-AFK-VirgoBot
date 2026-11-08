'use strict';

const { GoalBlock, GoalFollow, GoalNear } = require('mineflayer-pathfinder').goals;
const { Vec3 } = require('vec3');
const { moveTo, withTimeout } = require('./ai-utils');
const { requiredPickaxeTier } = require('./ai-reasoner');
const {
  ANIMALS,
  BREED_FOODS,
  COOKED_FOOD,
  FOOD_NAMES,
  HOSTILE_MOBS,
  LOG_NAMES,
  PICKAXE_BY_TIER,
  PLANK_NAMES,
  RAW_TO_COOKED,
  TOOL_TIER,
  bestPickaxe,
  canonicalItem,
  formatInventory,
  formatPosition,
  formatTime,
  inventoryFromList,
  isFood,
  isLog,
  isPlank,
  plankForLog,
  total
} = require('./ai-brain');

const UNSAFE_TUNNEL_BLOCKS = new Set(['lava', 'flowing_lava', 'water', 'flowing_water', 'fire', 'soul_fire']);
const MAX_ACTIONS_PER_TASK = 160;
const MAX_RECIPE_DEPTH = 7;
const DEFAULT_MINING_DISTANCE = 32;
const LOOP_DELAY_MS = 120;

class TaskAbortedError extends Error {
  constructor() {
    super('Task stopped.');
    this.name = 'TaskAbortedError';
  }
}

class AISkills {
  constructor({ agent, getBot, memory, config = {}, onProgress = () => {}, runId = null }) {
    this.agent = agent;
    this.getBot = getBot;
    this.memory = memory;
    this.config = config;
    this.onProgress = onProgress;
    this.runId = runId;
    this.actionCount = 0;
    this.lastProgressAt = 0;
    this.lastProgressText = '';
  }

  get bot() {
    return this.getBot();
  }

  isAborted() {
    if (this.runId !== null && this.agent && this.agent.runId !== this.runId) return true;
    return false;
  }

  assertActive() {
    if (this.isAborted()) throw new TaskAbortedError();
    const bot = this.bot;
    if (!bot) throw new Error('Minecraft bot is not connected.');
    return bot;
  }

  async wait(milliseconds) {
    const end = Date.now() + Math.max(0, milliseconds);
    while (Date.now() < end) {
      this.assertActive();
      await new Promise(resolve => setTimeout(resolve, Math.min(200, end - Date.now())));
    }
  }

  async goto(goal, options = {}) {
    const bot = this.assertActive();
    const retries = Math.max(0, Math.min(1, Number(options.retries ?? 1)));
    const moveOptions = { ...options };
    delete moveOptions.retries;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await moveTo(bot, goal, moveOptions);
        this.assertActive();
        return result;
      } catch (error) {
        lastError = error;
        this.assertActive();
        if (attempt >= retries) break;
        this.progress('Path blocked; retrying the route once.', { force: true });
        await this.wait(250);
      }
    }
    throw lastError;
  }

  async action(callback) {
    this.actionCount += 1;
    if (this.actionCount > MAX_ACTIONS_PER_TASK) {
      throw new Error(`Stopped after ${MAX_ACTIONS_PER_TASK} actions to keep the task bounded.`);
    }
    this.assertActive();
    return callback();
  }

  progress(message, { force = false } = {}) {
    if (typeof message !== 'string' || !message.trim()) return;
    const now = Date.now();
    if (!force && now - this.lastProgressAt < 5000) return;
    if (!force && message === this.lastProgressText) return;
    this.lastProgressAt = now;
    this.lastProgressText = message;
    try {
      this.onProgress(message.trim().slice(0, 180));
    } catch {
      // Chat progress must never interrupt the task.
    }
  }

  inventory() {
    const bot = this.assertActive();
    const counts = {};
    if (bot.inventory?.items) {
      for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
      }
    }
    return counts;
  }

  countItem(name) {
    const inventory = this.inventory();
    const normalized = canonicalItem(name);
    if (normalized === 'bed') return Object.entries(inventory)
      .filter(([item, count]) => count > 0 && item.endsWith('_bed'))
      .reduce((sum, [, count]) => sum + count, 0);
    if (isLog(normalized)) return total(inventory, [...LOG_NAMES]);
    if (isPlank(normalized)) return total(inventory, [...PLANK_NAMES]);
    if (normalized === 'food') return Object.entries(inventory)
      .filter(([item, count]) => count > 0 && FOOD_NAMES.has(item))
      .reduce((sum, [, count]) => sum + count, 0);
    if (normalized === 'pickaxe') {
      return Object.entries(inventory)
        .filter(([item, count]) => count > 0 && item.endsWith('_pickaxe'))
        .reduce((sum, [, count]) => sum + count, 0);
    }
    if (normalized === 'sword') {
      return Object.entries(inventory)
        .filter(([item, count]) => count > 0 && item.endsWith('_sword'))
        .reduce((sum, [, count]) => sum + count, 0);
    }
    return inventory[normalized] || 0;
  }

  hasItem(name, count = 1) {
    return this.countItem(name) >= count;
  }

  findInventoryItem(name) {
    const bot = this.assertActive();
    if (!bot.inventory?.items) return null;
    const normalized = canonicalItem(name);
    return bot.inventory.items().find(item => {
      if (item.name === normalized) return true;
      if (normalized === 'bed') return item.name.endsWith('_bed');
      if (isLog(normalized)) return isLog(item.name);
      if (isPlank(normalized)) return isPlank(item.name);
      if (normalized === 'food') return FOOD_NAMES.has(item.name);
      if (normalized === 'pickaxe') return item.name.endsWith('_pickaxe');
      if (normalized === 'sword') return item.name.endsWith('_sword');
      return false;
    }) || null;
  }

  equipmentSlot(name) {
    if (name.endsWith('_helmet') || name === 'carved_pumpkin') return 'head';
    if (name.endsWith('_chestplate') || name === 'elytra') return 'torso';
    if (name.endsWith('_leggings')) return 'legs';
    if (name.endsWith('_boots')) return 'feet';
    if (name === 'shield' || name === 'totem_of_undying') return 'off-hand';
    return 'hand';
  }

  async equipItem(name) {
    const bot = this.assertActive();
    const item = this.findInventoryItem(name);
    if (!item) throw new Error(`No ${name.replace(/_/g, ' ')} in my inventory.`);
    const slot = this.equipmentSlot(item.name);
    if (slot === 'hand' && bot.heldItem?.name === item.name) return item;
    if (slot !== 'hand' && bot.entity?.equipment?.[{ head: 5, torso: 4, legs: 3, feet: 2 }[slot]]?.name === item.name) return item;
    await bot.equip(item, slot);
    return item;
  }

  armorTier(name) {
    const match = String(name || '').match(/^(leather|chainmail|golden|iron|turtle|diamond|netherite)_(?:helmet|chestplate|leggings|boots)$/);
    if (!match) return 0;
    return { leather: 1, chainmail: 2, golden: 2, iron: 3, turtle: 3, diamond: 4, netherite: 5 }[match[1]] || 0;
  }

  async equipBestArmor() {
    const bot = this.assertActive();
    if (!bot.inventory?.items) return [];
    const slots = [
      { key: 'boots', equipmentIndex: 2, slot: 'feet' },
      { key: 'leggings', equipmentIndex: 3, slot: 'legs' },
      { key: 'chestplate', equipmentIndex: 4, slot: 'torso' },
      { key: 'helmet', equipmentIndex: 5, slot: 'head' }
    ];
    const equipped = [];
    for (const entry of slots) {
      const current = bot.entity?.equipment?.[entry.equipmentIndex];
      const candidates = bot.inventory.items()
        .filter(item => item.name.endsWith(`_${entry.key === 'leggings' ? 'leggings' : entry.key === 'chestplate' ? 'chestplate' : entry.key === 'helmet' ? 'helmet' : 'boots'}`))
        .sort((left, right) => this.armorTier(right.name) - this.armorTier(left.name));
      const best = candidates[0];
      if (best && this.armorTier(best.name) > this.armorTier(current?.name)) {
        await bot.equip(best, entry.slot);
        equipped.push(best.name);
      }
    }
    return equipped;
  }

  async equipBestSword() {
    const bot = this.assertActive();
    if (!bot.inventory?.items) return null;
    const sword = bot.inventory.items()
      .filter(item => item.name.endsWith('_sword'))
      .sort((left, right) => this.toolTier(right.name) - this.toolTier(left.name))[0];
    if (sword) await this.equipItem(sword.name);
    return sword || null;
  }

  toolTier(name) {
    if (name.endsWith('_pickaxe')) return TOOL_TIER[name] || 0;
    if (name.endsWith('_sword')) {
      return { wooden_sword: 1, stone_sword: 2, golden_sword: 1, iron_sword: 3, diamond_sword: 4, netherite_sword: 5 }[name] || 0;
    }
    if (name.endsWith('_axe')) {
      return { wooden_axe: 1, stone_axe: 2, golden_axe: 1, iron_axe: 3, diamond_axe: 4, netherite_axe: 5 }[name] || 0;
    }
    return 0;
  }

  observation() {
    const bot = this.assertActive();
    const inventory = this.inventory();
    const position = bot.entity?.position || new Vec3(0, 0, 0);
    const nearbyBlocks = [];
    try {
      const positions = bot.findBlocks({
        matching: block => block?.name && block.name !== 'air' && block.name !== 'cave_air',
        maxDistance: Number(this.config?.scanDistance) || 12,
        count: Number(this.config?.scanCount) || 48
      });
      const counts = new Map();
      for (const blockPosition of positions) {
        const block = bot.blockAt(blockPosition);
        if (!block) continue;
        const distance = Math.round(position.distanceTo(block.position));
        const key = block.name;
        if (counts.has(key)) continue;
        const entry = { name: key, distance, position: { x: Math.floor(block.position.x), y: Math.floor(block.position.y), z: Math.floor(block.position.z) } };
        counts.set(key, entry);
        nearbyBlocks.push(entry);
      }
    } catch {
      // Block scanning is best effort.
    }
    const entities = Object.values(bot.entities || {}).filter(entity => entity?.position && entity !== bot.entity);
    const nearbyHostiles = entities
      .filter(entity => entity.type === 'mob' && HOSTILE_MOBS.has(entity.name) && position.distanceTo(entity.position) <= 20)
      .map(entity => ({
        name: entity.name,
        distance: Math.round(position.distanceTo(entity.position)),
        position: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      }))
      .sort((left, right) => left.distance - right.distance);
    const players = {};
    const onlinePlayers = [];
    for (const [name, player] of Object.entries(bot.players || {})) {
      if (name === bot.username) continue;
      const ping = (player && typeof player.ping === 'number') ? player.ping : null;
      if (player?.entity) {
        players[name] = {
          username: name,
          distance: Math.round(position.distanceTo(player.entity.position)),
          position: {
            x: Math.floor(player.entity.position.x),
            y: Math.floor(player.entity.position.y),
            z: Math.floor(player.entity.position.z)
          },
          ping
        };
      }
      onlinePlayers.push({ username: name, ping, online: true });
    }
    const nearbyEntities = entities
      .filter(entity => position.distanceTo(entity.position) <= 20)
      .map(entity => ({
        name: entity.username || entity.name || entity.type || 'unknown',
        kind: entity.type || 'unknown',
        distance: Math.round(position.distanceTo(entity.position)),
        position: {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z)
        }
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 20);
    const equipment = bot.entity?.equipment || [];
    const armor = { boots: equipment[2]?.name || null, leggings: equipment[3]?.name || null, chestplate: equipment[4]?.name || null, helmet: equipment[5]?.name || null };
    const hazards = nearbyBlocks.filter(block => /^(?:lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/.test(block.name)).sort((a, b) => a.distance - b.distance).slice(0, 8);
    let nearbyBedAvailable = false;
    try {
      nearbyBedAvailable = Boolean(bot.findBlock?.({
        matching: block => block?.name?.endsWith('_bed'),
        maxDistance: Number(this.config?.scanDistance) || 12
      }));
    } catch {
      // Bed discovery is best effort and limited to loaded nearby blocks.
    }
    return {
      position: { x: position.x, y: position.y, z: position.z },
      dimension: bot.game?.dimension || null,
      weather: { raining: Boolean(bot.isRaining), thunder: Number(bot.thunderState) > 0 },
      armor, hazards,
      recentEvents: Array.isArray(bot.aiRecentEvents) ? bot.aiRecentEvents.slice(-8) : [],
      health: bot.health,
      food: bot.food,
      oxygen: bot.oxygenLevel,
      time: {
        timeOfDay: bot.time?.timeOfDay,
        day: bot.time?.day,
        isDay: bot.time?.isDay
      },
      inventory,
      inventoryList: bot.inventory.items().map(item => ({ name: item.name, count: item.count })),
      nearbyBlocks,
      nearbyHostiles,
      nearbyBedAvailable,
      screen: bot.aiPerception || null,
      shelter: Boolean(this.memory?.getFact?.('shelter')),
      nearbyEntities,
      players,
      onlinePlayers,
      server: {
        difficulty: bot.game?.difficulty || null,
        gameMode: bot.game?.gameMode || null,
        hardcore: Boolean(bot.game?.hardcore),
        maxPlayers: bot.game?.maxPlayers ?? null,
        serverBrand: bot.game?.serverBrand || null
      },
      heldItem: bot.heldItem?.name || null,
      deathRecoveryAvailable: Boolean(this.agent?.hasDeathRecovery?.())
    };
  }

  playerEntity(name) {
    const bot = this.assertActive();
    if (!name || name === 'requester') {
      const requester = this.agent?.requestedBy;
      if (!requester) return null;
      name = requester;
    }
    const player = Object.entries(bot.players || {}).find(([username]) =>
      username.toLowerCase() === String(name).toLowerCase())?.[1];
    return player?.entity || null;
  }

  async comeToPlayer(name = 'requester') {
    const bot = this.assertActive();
    const targetName = name === 'requester' ? this.agent?.requestedBy : name;
    if (!targetName) throw new Error('I do not know which player to come to.');

    // 1. Locate player entity via playerEntity helper
    let entity = this.playerEntity(targetName);
    let targetPos = entity?.position ? entity.position.clone() : null;

    // 2. Locate via bot.players table
    if (!targetPos) {
      const playerObj = Object.entries(bot.players || {}).find(([username]) =>
        username.toLowerCase() === String(targetName).toLowerCase())?.[1];
      if (playerObj?.entity?.position) {
        targetPos = playerObj.entity.position.clone();
      }
    }

    // 3. Locate via global entities map
    if (!targetPos) {
      const foundEntity = Object.values(bot.entities || {}).find(e =>
        (e.username && e.username.toLowerCase() === String(targetName).toLowerCase()) ||
        (e.name && e.name.toLowerCase() === String(targetName).toLowerCase())
      );
      if (foundEntity?.position) {
        targetPos = foundEntity.position.clone();
      }
    }

    // 4. Locate via saved coordinates or waypoints
    if (!targetPos) {
      const waypoint = this.memory?.getWaypoint?.(targetName) ||
        this.memory?.getFact?.(`playerLocation:${targetName.toLowerCase()}`);
      if (waypoint?.x !== undefined) {
        targetPos = new Vec3(waypoint.x, waypoint.y, waypoint.z);
      }
    }

    if (!targetPos) {
      throw new Error(`${targetName} is out of view range. Type your coordinates (e.g. !ai come ${Math.floor(bot.entity.position.x)} ${Math.floor(bot.entity.position.y)} ${Math.floor(bot.entity.position.z)}) so I can navigate straight to you!`);
    }

    return this.navigateToCoordinates(targetPos, targetName);
  }

  async gotoCoordinates(x, y, z) {
    const targetPos = new Vec3(Number(x), Number(y), Number(z));
    if (!Number.isFinite(targetPos.x) || !Number.isFinite(targetPos.y) || !Number.isFinite(targetPos.z)) {
      throw new Error(`Invalid coordinates: ${x}, ${y}, ${z}`);
    }
    return this.navigateToCoordinates(targetPos, 'coordinates');
  }

  async navigateToCoordinates(targetPos, label = 'target') {
    const bot = this.assertActive();
    const distance = bot.entity.position.distanceTo(targetPos);
    const isUnderground = targetPos.y < bot.entity.position.y - 3;

    // Enable digging in pathfinder movements so obstacle blocks can be broken
    const movements = bot.pathfinder?.movements;
    const prevCanDig = movements?.canDig;
    if (movements) {
      movements.canDig = true;
      movements.digCost = 15;
    }

    this.progress(`Coming to ${label} (${Math.round(distance)} blocks away${isUnderground ? ', underground' : ''})...`, { force: true });

    try {
      const moveTimeout = Math.max(45000, Math.round(distance * 1500));
      await withTimeout(
        this.goto(new GoalNear(targetPos.x, targetPos.y, targetPos.z, 2)),
        moveTimeout,
        `Moving towards ${label}`
      );
    } catch (err) {
      // If path is blocked by solid ground and target is underground, excavate a safe staircase down!
      if (isUnderground) {
        this.progress(`Direct path blocked; excavating a safe staircase down to ${label} at Y=${Math.floor(targetPos.y)}...`, { force: true });
        await this.digDownToTarget(targetPos, label);
      } else {
        throw err;
      }
    } finally {
      if (movements && prevCanDig !== undefined) movements.canDig = prevCanDig;
    }

    const after = this.playerEntity(label);
    const finalDist = after ? bot.entity.position.distanceTo(after.position) : bot.entity.position.distanceTo(targetPos);
    if (finalDist > 6 && label !== 'coordinates') {
      throw new Error(`I reached the area (${Math.floor(targetPos.x)}, ${Math.floor(targetPos.y)}, ${Math.floor(targetPos.z)}), but ${label} moved away.`);
    }
    if (label !== 'coordinates' && finalDist <= 4) {
      return { message: `I'm next to you, ${label}!`, target: label };
    }
    return { message: `I reached ${label} at ${Math.floor(targetPos.x)}, ${Math.floor(targetPos.y)}, ${Math.floor(targetPos.z)}!`, target: label };
  }

  async digDownToTarget(targetPos, label) {
    const bot = this.assertActive();

    // First: walk on surface horizontally as close as possible above target
    try {
      await this.goto(new GoalNear(targetPos.x, bot.entity.position.y, targetPos.z, 3), { timeoutMs: 25000 });
    } catch {
      // Continue from current position
    }

    // Equip best pickaxe
    const pick = bot.inventory.items().find(i => i.name.endsWith('_pickaxe'));
    if (pick) await this.equipItem(pick.name);

    let maxSteps = 120;
    while (maxSteps-- > 0) {
      this.assertActive();
      const current = bot.entity.position;
      const dy = current.y - targetPos.y;
      const hDist = Math.hypot(current.x - targetPos.x, current.z - targetPos.z);

      // Reached target level and nearby
      if (Math.abs(dy) <= 2 && hDist <= 3) {
        // Break any partition wall between bot and target
        const eyeVector = targetPos.minus(current).normalize();
        const blocker = bot.blockAt(current.offset(Math.round(eyeVector.x), 0, Math.round(eyeVector.z)));
        if (blocker && blocker.name !== 'air' && blocker.name !== 'cave_air' && blocker.diggable) {
          try { await withTimeout(bot.dig(blocker), 10000, 'Opening wall'); } catch {}
        }
        break;
      }

      // Safe step vector (spiral staircase pattern, never digging straight down under feet)
      let dx = Math.sign(targetPos.x - current.x);
      let dz = Math.sign(targetPos.z - current.z);
      if (dx === 0 && dz === 0) {
        dx = (maxSteps % 2 === 0) ? 1 : 0;
        dz = (maxSteps % 2 !== 0) ? 1 : 0;
      }

      const nextFloor = current.floored().offset(dx, 0, dz);

      // Clear head, eye, and step-down block ahead
      for (const offsetDy of [1, 0, -1]) {
        const blk = bot.blockAt(nextFloor.offset(0, offsetDy, 0));
        if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.diggable) {
          if (blk.name === 'lava' || blk.name === 'flowing_lava') {
            throw new Error('Hit lava while digging down. Stopped for safety.');
          }
          const tool = bot.inventory.items().find(i =>
            (blk.name.includes('dirt') || blk.name.includes('sand') || blk.name.includes('gravel'))
              ? i.name.endsWith('_shovel')
              : i.name.endsWith('_pickaxe')
          );
          if (tool) await this.equipItem(tool.name);
          await withTimeout(bot.dig(blk), 12000, 'Digging staircase step');
          await this.wait(60);
        }
      }

      // Step down to next step
      try {
        await this.goto(new GoalNear(nextFloor.x + 0.5, nextFloor.y - 1, nextFloor.z + 0.5, 1), { timeoutMs: 6000 });
      } catch {
        // Continue digging
      }
      await this.wait(80);
    }
  }

  async followPlayer(name = 'requester', durationMs = 60000) {
    const bot = this.assertActive();
    const targetName = name === 'requester' ? this.agent?.requestedBy : name;
    if (!targetName) throw new Error('I do not know which player to follow.');
    let entity = this.playerEntity(targetName);
    if (!entity) {
      entity = Object.values(bot.entities || {}).find(e =>
        e.username && e.username.toLowerCase() === String(targetName).toLowerCase()
      );
    }
    if (!entity) throw new Error(`${targetName} is not visible to me right now.`);
    this.progress(`Following ${targetName}. Say !ai stop to end it.`, { force: true });
    bot.pathfinder.setGoal(new GoalFollow(entity, 2), true);
    const end = Date.now() + Math.max(5000, Math.min(durationMs || 60000, 300000));
    try {
      while (Date.now() < end) {
        this.assertActive();
        const current = this.playerEntity(targetName) || Object.values(bot.entities || {}).find(e =>
          e.username && e.username.toLowerCase() === String(targetName).toLowerCase()
        );
        if (!current) break;
        const distance = bot.entity.position.distanceTo(current.position);
        if (distance > 4 && !bot.pathfinder.isMoving()) {
          bot.pathfinder.setGoal(new GoalFollow(current, 2), true);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      bot.pathfinder.stop();
    }
    return { message: `Finished following ${targetName}.` };
  }

  async stay() {
    const bot = this.assertActive();
    bot.pathfinder.stop();
    bot.clearControlStates?.();
    return { message: 'Holding position.' };
  }

  async explore(radius = 24, options = {}) {
    const bot = this.assertActive();
    for (let i = 0; i < 20; i += 1) {
      const p = bot.entity.position;
      if (!(Math.floor(p.x) === 1000 && Math.floor(p.z) === 1000)) break;
      await this.wait(250);
    }
    const origin = bot.entity.position.clone();
    const boundedRadius = Math.max(8, Math.min(Number(radius) || 24, 64));
    const sweep = Number.isInteger(options.areaSweep) ? options.areaSweep : null;
    const baseAngle = sweep === null ? Math.random() * Math.PI * 2 : (sweep / 8) * Math.PI * 2;
    let lastError = null;
    const movements = bot.pathfinder?.movements;
    const previousCanDig = movements?.canDig;
    if (movements) movements.canDig = true;
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const angle = Math.random() * Math.PI * 2;
        const distance = 6 + Math.random() * 12;
        const targetX = Math.floor(origin.x + Math.cos(angle) * distance);
        const targetZ = Math.floor(origin.z + Math.sin(angle) * distance);
        const targetY = this.findStandY(bot, targetX, targetZ, Math.floor(origin.y) + 2);
        if (!below || below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air') {
          continue;
        }
        try {
          await this.goto(new GoalNear(target.x, target.y, target.z, 3), { timeoutMs: 45000 });
          const position = bot.entity.position;
          if (position.distanceTo(origin) > 3) {
            const name = `scout-${Math.floor(position.x)}-${Math.floor(position.z)}`;
            this.memory?.addWaypoint?.(name, position, { kind: 'scout' });
            return {
              exploredTo: [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)],
              message: `Scouted to ${formatPosition({ position })}.`
            };
          }
        } catch (error) {
          lastError = error;
          try {
            const probe = await bot.pathfinder.getPathTo(movements || bot.pathfinder.movements, new GoalNear(target.x, target.y, target.z, 3), 100);
            console.log(`[Explore] attempt ${attempt} failed from ${formatPosition({ position: origin })} to ${target.x},${target.y},${target.z}: ${error.message} | path status: ${probe?.status}`);
          } catch (probeError) {
            console.log(`[Explore] attempt ${attempt} failed; probe error: ${probeError.message}`);
          }
        }
      }
    } finally {
      if (movements) movements.canDig = previousCanDig;
    }
    const skyPlatform = this.isSkyPlatform(bot);
    if (skyPlatform) {
      const configured = this.config?.spawnCommands;
      const commands = Array.isArray(configured) && configured.length
        ? configured
        : [this.config?.spawnCommand || '/is go', '/spawn', '/warp survival'];
      for (const command of commands) {
        console.log(`[Explore] Sky spawn platform detected; trying ${command}`);
        try {
          bot.chat(command);
        } catch {
          continue;
        }
        await this.wait(6000);
        if (bot.entity.position.distanceTo(origin) > 8) {
          const position = bot.entity.position;
          return {
            exploredTo: [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)],
            message: `Used ${command} and left the spawn platform for ${formatPosition({ position })}.`
          };
        }
      }
      const now = Date.now();
      if (!this._platformNoticeAt || now - this._platformNoticeAt > 120000) {
        this._platformNoticeAt = now;
        console.log('[Explore] Spawn platform has no safe route out; standing by instead of walking off the edge.');
      }
      return {
        exploredTo: [Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)],
        message: 'On the spawn platform: no safe route exists, so I am standing by for a teleport instead of risking the void.',
        waitedOnPlatform: true
      };
    }
    if (await this.stepOnTeleportPad(bot, origin)) {
      const position = bot.entity.position;
      return {
        exploredTo: [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)],
        message: `Stepped on a teleport pad and moved to ${formatPosition({ position })}.`
      };
    }
    const dug = await this.emergencyDigOut(bot);
    console.log(`[Explore] Fallback after path failures: dug=${dug}, position=${formatPosition({ position: bot.entity.position })}`);
    try {
      const base = bot.entity.position.floored();
      const around = [];
      for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
        const feet = bot.blockAt(base.offset(dx, 0, dz));
        const head = bot.blockAt(base.offset(dx, 1, dz));
        around.push(`${dx},${dz}:${feet?.name || '?'}/${head?.name || '?'}`);
      }
      const below = [];
      for (let dy = 1; dy <= 5; dy += 1) {
        below.push(bot.blockAt(base.offset(0, -dy, 0))?.name || '?');
      }
      console.log(`[Explore] Around: ${around.join(' ')} | Below: ${below.join(',')}`);
      const interesting = ['water', 'ladder', 'vine', 'nether_portal', 'end_portal', 'oak_stairs', 'stone_bricks', 'grass_block'];
      const found = [];
      for (const name of interesting) {
        const block = bot.findBlock({ matching: b => b?.name === name, maxDistance: 24 });
        if (block) found.push(`${name}@${block.position.x},${block.position.y},${block.position.z}`);
      }
      console.log(`[Explore] Landmarks: ${found.join(' ') || 'none within 24'}`);
    } catch { }
    if (dug > 0) {
      try {
        await this.goto(new GoalNear(
          Math.floor(origin.x + 4), Math.floor(origin.y), Math.floor(origin.z), 3
        ));
      } catch (error) {
        lastError = error;
      }
      const position = bot.entity.position;
      if (position.distanceTo(origin) > 1) {
        const name = `scout-${Math.floor(position.x)}-${Math.floor(position.z)}`;
        this.memory?.addWaypoint?.(name, position, { kind: 'scout' });
        return {
          exploredTo: [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)],
          message: `Dug out and scouted to ${formatPosition({ position })}.`
        };
      }
      return {
        exploredTo: [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)],
        message: `No route was available, so I dug out ${dug} block${dug === 1 ? '' : 's'} to get unstuck at ${formatPosition({ position })}.`
      };
    }
    const walked = await this.walkForward(bot, 1800);
    console.log(`[Explore] Manual walk moved ${walked.toFixed(2)} blocks from ${formatPosition({ position: origin })}`);
    if (walked > 1) {
      const position = bot.entity.position;
      const name = `scout-${Math.floor(position.x)}-${Math.floor(position.z)}`;
      this.memory?.addWaypoint?.(name, position, { kind: 'scout' });
      return {
        exploredTo: [Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)],
        message: `Walked ${Math.round(walked)} blocks to ${formatPosition({ position })}.`
      };
    }
    throw new Error(`I could not find a safe route to explore${lastError ? `: ${lastError.message}` : '.'}`);
  }

  isSkyPlatform(bot) {
    const base = bot.entity.position.floored();
    const ground = bot.blockAt(base.offset(0, -1, 0));
    if (!ground) return false;
    const spawnBlocks = new Set([
      'gray_concrete', 'white_concrete', 'light_gray_concrete', 'black_concrete',
      'smooth_stone', 'stone_bricks', 'quartz_block', 'glass', 'barrier'
    ]);
    if (!spawnBlocks.has(ground.name)) return false;
    for (let dy = 2; dy <= 6; dy += 1) {
      const block = bot.blockAt(base.offset(0, -dy, 0));
      if (block && block.name !== 'air' && block.name !== 'cave_air') return false;
    }
    return true;
  }

  async stepOnTeleportPad(bot, origin) {
    const plate = bot.findBlock({
      matching: block => /pressure_plate$/.test(block?.name || ''),
      maxDistance: 48
    });
    console.log(`[Explore] Plate probe: ${plate ? `${plate.name}@${plate.position.x},${plate.position.y},${plate.position.z}` : 'none within 48'}`);
    if (!plate) return false;
    const target = new Vec3(plate.position.x + 0.5, plate.position.y + 0.2, plate.position.z + 0.5);
    console.log(`[Explore] Trying teleport pad ${plate.name} at ${plate.position.x}, ${plate.position.y}, ${plate.position.z}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const steps = Math.ceil(origin.distanceTo(target));
      try {
        await bot.lookAt(target, true);
      } catch {
        // Keep facing.
      }
      bot.setControlState('forward', true);
      await this.wait(Math.min(2500, Math.max(400, steps * 220)));
      bot.setControlState('forward', false);
      await this.wait(600);
      if (bot.entity.position.distanceTo(origin) > 2) return true;
    }
    return false;
  }

  findStandY(bot, x, z, baseY) {
    for (let y = baseY + 5; y >= baseY - 8; y -= 1) {
      const feet = bot.blockAt(new Vec3(x, y, z));
      const head = bot.blockAt(new Vec3(x, y + 1, z));
      const ground = bot.blockAt(new Vec3(x, y - 1, z));
      if (!feet || !head || !ground) continue;
      const passable = block => block.name === 'air' || block.name === 'cave_air';
      if (passable(feet) && passable(head) && ground.boundingBox === 'block') return y;
    }
    return baseY;
  }

  async walkForward(bot, durationMs = 1500) {
    const start = bot.entity.position.clone();
    let best = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const angle = (Math.PI / 2) * attempt + Math.random() * 0.3;
      const aim = new Vec3(start.x + Math.cos(angle) * 8, start.y, start.z + Math.sin(angle) * 8);
      try {
        await bot.lookAt(aim, true);
      } catch {
        // Keep the current facing if the look packet fails.
      }
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      try {
        await this.wait(Math.max(600, Math.floor(durationMs / 4)));
      } finally {
        bot.setControlState('sprint', false);
        bot.setControlState('forward', false);
      }
      const moved = bot.entity.position.distanceTo(start);
      if (moved > best) best = moved;
      if (moved > 1) break;
    }
    return best;
  }

  async emergencyDigOut(bot) {
    const base = bot.entity.position.floored();
    let dug = 0;
    for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      for (const dy of [0, 1]) {
        const block = bot.blockAt(base.offset(dx, dy, dz));
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        if (block.diggable === false || UNSAFE_TUNNEL_BLOCKS.has(block.name)) continue;
        try {
          await withTimeout(bot.dig(block), 8000, 'Emergency digging', () => bot.stopDigging?.());
          dug += 1;
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
        }
        if (dug >= 2) return dug;
      }
    }
    return dug;
  }

  async ensureCraftingTable() {
    const bot = this.assertActive();
    let tableBlock = bot.findBlock({
      matching: block => block.name === 'crafting_table',
      maxDistance: 8
    });
    if (tableBlock) return tableBlock;

    await this.ensureItem('crafting_table', 1, 0, { skipTable: true });
    const tableItem = this.findInventoryItem('crafting_table');
    if (!tableItem) throw new Error('I could not craft a crafting table.');
    await this.equipItem('crafting_table');

    const base = bot.entity.position.floored();
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const support = bot.blockAt(base.offset(dx, -1, dz));
          const target = bot.blockAt(base.offset(dx, 0, dz));
          if (!support || support.boundingBox !== 'block' || !target || target.name !== 'air') continue;
          if (Math.abs(support.position.x + 0.5 - bot.entity.position.x) < 0.9 &&
            Math.abs(support.position.z + 0.5 - bot.entity.position.z) < 0.9) continue;
          try {
            await this.equipItem('crafting_table');
            await withTimeout(bot.placeBlock(support, new Vec3(0, 1, 0)), 8000, 'Placing a block');
            await this.wait(250);
            // Pick up the placed table so it is in the bot's hands for crafting
            await withTimeout(bot.rightClick(), 8000, 'Picking up crafting table');
            const placed = bot.blockAt(support.position.offset(0, 1, 0));
            if (placed?.name === 'crafting_table') {
              // The item should be in the bot's hands now
              const held = bot.heldItem;
              if (held && held.name === 'crafting_table') {
                return held;
              }
              // Fallback: find the item in inventory
              const inventoryItem = bot.inventory.find(item => item?.name === 'crafting_table');
              if (inventoryItem) return inventoryItem;
            }
          } catch {
            // Try the next spot.
          }
        }
      }
    }
    throw new Error('I could not find a clear spot for the crafting table.');
  }

  async ensureItem(name, count = 1, depth = 0, { skipTable = false } = {}) {
    const bot = this.assertActive();
    const requested = canonicalItem(name);
    const amount = Math.max(1, Math.min(Number(count) || 1, 256));
    if (depth > MAX_RECIPE_DEPTH) throw new Error(`Recipe for ${requested} is too deep.`);
    if (await this.isSatisfied(requested, amount)) return { item: requested, count: this.countItem(requested) };

    if (isLog(requested)) {
      await this.gatherWood(Math.max(amount, 8));
      return { item: requested, count: this.countItem(requested) };
    }
    if (isPlank(requested)) {
      return this.ensurePlanks(amount, depth);
    }
    if (requested === 'food') {
      await this.gatherFood(amount);
      return { item: requested, count: this.countItem(requested) };
    }
    if (requested === 'cobblestone' || requested === 'stone') {
      await this.mine('stone', amount);
      return { item: requested, count: this.countItem(requested) };
    }
    if (requested === 'coal') {
      if (this.countItem('coal') + this.countItem('charcoal') >= amount) {
        return { item: requested, count: this.countItem('coal') + this.countItem('charcoal') };
      }
      await this.mine('coal_ore', amount);
      if (this.countItem('coal') + this.countItem('charcoal') < amount) {
        try {
          await this.smelt('charcoal', amount - this.countItem('coal') - this.countItem('charcoal'));
        } catch {
          // Coal ore is the primary source.
        }
      }
      return { item: requested, count: this.countItem('coal') + this.countItem('charcoal') };
    }
    if (requested === 'iron_ingot') {
      if (this.countItem('iron_ingot') >= amount) return { item: requested, count: this.countItem('iron_ingot') };
      const raw = this.countItem('raw_iron') + this.countItem('iron_ore');
      if (raw < amount) await this.mine('iron_ore', Math.max(amount - raw, 1));
      const available = this.countItem('raw_iron') + this.countItem('iron_ore');
      if (available > 0) await this.smelt('iron_ingot', Math.min(amount, available));
      return { item: requested, count: this.countItem('iron_ingot') };
    }
    if (requested === 'charcoal') {
      const log = this.findInventoryItem('oak_log');
      if (!log) await this.gatherWood(4);
      await this.smelt('charcoal', amount);
      return { item: requested, count: this.countItem('charcoal') };
    }
    if (requested === 'torch') {
      const coal = this.countItem('coal') + this.countItem('charcoal');
      if (coal < 1) {
        try {
          await this.mine('coal_ore', 1);
        } catch {
          await this.ensureItem('charcoal', 1, depth + 1);
        }
      }
      await this.ensureItem('stick', Math.max(1, Math.ceil(amount / 4)), depth + 1);
      return this.craftRecipe('torch', amount, depth);
    }
    if (requested === 'bed') {
      const beds = this.countItem('bed');
      if (beds >= amount) return { item: requested, count: beds };
      const wool = this.countItem('white_wool');
      if (wool < amount * 3) await this.gatherWool(amount * 3);
      await this.ensureItem('oak_planks', amount * 3, depth + 1);
      return this.craftRecipe('bed', amount, depth);
    }

    return this.craftRecipe(requested, amount, depth, { skipTable });
  }

  async isSatisfied(name, count) {
    if (name.endsWith('_pickaxe')) {
      const best = bestPickaxe(this.inventory());
      return Boolean(best && (TOOL_TIER[best] || 0) >= (TOOL_TIER[name] || 1));
    }
    if (name.endsWith('_sword')) {
      const sword = this.findInventoryItem('sword');
      return Boolean(sword && this.toolTier(sword.name) >= this.toolTier(name));
    }
    if (name.endsWith('_axe')) {
      const axe = this.bot?.inventory?.items ? this.bot.inventory.items().find(item => item.name.endsWith('_axe')) : null;
      return Boolean(axe && this.toolTier(axe.name) >= this.toolTier(name));
    }
    return this.countItem(name) >= count;
  }

  async ensurePlanks(count, depth) {
    if (this.countItem('oak_planks') >= count) return { item: 'oak_planks', count: this.countItem('oak_planks') };
    const bot = this.assertActive();
    const logType = bot.inventory?.items ? bot.inventory.items().find(item => isLog(item.name))?.name : null;
    if (logType) {
      const planksName = plankForLog(logType);
      return this.craftRecipe(planksName, count, depth);
    }
    if (this.countItem('oak_planks') > 0) return { item: 'oak_planks', count: this.countItem('oak_planks') };
    await this.gatherWood(4);
    const newLog = bot.inventory?.items ? bot.inventory.items().find(item => isLog(item.name))?.name : null;
    if (!newLog) throw new Error('I could not collect any logs to make planks.');
    return this.craftRecipe(plankForLog(newLog), count, depth);
  }

  async craftRecipe(name, count, depth, { skipTable = false } = {}) {
    const bot = this.assertActive();
    const normalized = canonicalItem(name);
    const item = bot.registry.itemsByName[normalized];
    if (!item) throw new Error(`Unknown item: ${normalized}`);
    const needed = Math.max(1, Number(count) || 1);
    const existing = this.countItem(normalized);
    if (existing >= needed) return { item: normalized, count: existing };

    let table = null;
    if (!skipTable) {
      const recipesNoTable = bot.recipesAll(item.id, null, false);
      if (recipesNoTable.length === 0) table = await this.ensureCraftingTable();
    }
    const recipes = bot.recipesAll(item.id, null, true);
    if (recipes.length === 0) {
      throw new Error(`I do not know a crafting recipe for ${normalized.replace(/_/g, ' ')}.`);
    }

    const craftCount = Math.ceil((needed - existing) / recipes[0].result.count);
    let best = null;
    let bestScore = -Infinity;
    for (const recipe of recipes) {
      if (recipe.requiresTable && !table && !skipTable) {
        // A table may be craftable; score it but do not reject it.
      }
      let score = 0;
      for (const delta of recipe.delta) {
        if (delta.count >= 0) continue;
        const ingredientName = bot.registry.items[delta.id]?.name;
        if (!ingredientName) continue;
        const need = -delta.count * craftCount;
        const have = this.countItem(ingredientName);
        if (have >= need) score += 8;
        else if (have > 0) score += 3;
        else if (this.isGatherable(ingredientName)) score += 2;
        else score += this.craftableScore(ingredientName);
      }
      if (recipe.requiresTable && table) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = recipe;
      }
    }
    if (!best) throw new Error(`No usable recipe for ${normalized}.`);
    if (best.requiresTable && !table) table = await this.ensureCraftingTable();

    const batches = Math.ceil((needed - existing) / best.result.count);
    for (const delta of best.delta) {
      if (delta.count >= 0) continue;
      const ingredientName = bot.registry.items[delta.id]?.name;
      if (!ingredientName) throw new Error(`Unknown ingredient ID ${delta.id}.`);
      const need = -delta.count * batches;
      if (this.countItem(ingredientName) < need) {
        await this.ensureItem(ingredientName, need, depth + 1);
      }
    }
    const craftable = bot.recipesFor(item.id, null, needed - existing, table)[0];
    if (!craftable) {
      throw new Error(`I have the ingredients but ${normalized.replace(/_/g, ' ')} is not craftable here.`);
    }
    this.progress(`Crafting ${needed - existing} ${normalized.replace(/_/g, ' ')}...`);
    await withTimeout(bot.craft(craftable, batches, best.requiresTable ? table : null), 20000, 'Crafting', () => { try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {} });
    await this.wait(250);
    return { item: normalized, count: this.countItem(normalized) };
  }

  craftableScore(name) {
    const bot = this.bot;
    const item = bot?.registry?.itemsByName?.[canonicalItem(name)];
    if (!item) return 0;
    const recipes = bot.recipesAll(item.id, null, true);
    return recipes.length ? 1 : 0;
  }

  isGatherable(name) {
    return isLog(name) || isPlank(name) || ['stone', 'cobblestone', 'coal', 'coal_ore', 'iron_ore', 'raw_iron', 'dirt', 'sand', 'gravel', 'food', 'wheat', 'carrot', 'potato', 'white_wool'].includes(name);
  }

  treeBase(bot, position) {
    let base = position.clone();
    for (let depth = 0; depth < 32; depth += 1) {
      const below = bot.blockAt(base.offset(0, -1, 0));
      if (!below || !isLog(below.name)) break;
      base = below.position.clone();
    }
    return base;
  }

  async chopReachableLogs(maximum = 8) {
    const bot = this.assertActive();
    let chopped = 0;
    for (let round = 0; round < Math.max(12, maximum * 2) && chopped < maximum; round += 1) {
      this.assertActive();
      const positions = bot.findBlocks({
        matching: block => isLog(block.name),
        maxDistance: 4.5,
        count: 32
      }).sort((left, right) => {
        const height = left.y - right.y;
        if (height !== 0) return height;
        return bot.entity.position.distanceTo(left) - bot.entity.position.distanceTo(right);
      });
      if (positions.length === 0) break;
      let dugThisRound = false;
      for (const position of positions) {
        const block = bot.blockAt(position);
        if (!block || !isLog(block.name) || !block.diggable) continue;
        if (bot.entity.position.distanceTo(block.position) > 4.6) continue;
        try {
          const axe = bot.inventory.items().find(item => item.name.endsWith('_axe'));
          if (axe) await this.equipItem(axe.name);
          await withTimeout(
            bot.dig(block),
            12000,
            'Chopping a log',
            () => bot.stopDigging?.()
          );
          await this.wait(250);
          chopped += 1;
          dugThisRound = true;
          break;
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
          if (error.name === 'TaskAbortedError') throw error;
        }
      }
      if (!dugThisRound) break;
    }
    return chopped;
  }

  async gatherWood(count = 16) {
    const bot = this.assertActive();
    const autonomous = Boolean(this.agent?.isAutonomousTask);
    if (autonomous) count = Math.min(8, Math.max(1, Number(count) || 8));
    const searchDistance = autonomous ? 16 : DEFAULT_MINING_DISTANCE;
    let remaining = Math.max(1, Number(count) || 16);
    let gathered = 0;
    let choppedBlocks = 0;
    let explorations = 0;
    let dryPasses = 0;
    const visited = new Set();
    const startInventory = this.inventory();
    const startLogCount = total(startInventory, [...LOG_NAMES]);
    const requestedCount = remaining;
    this.progress(`Chopping ${remaining} logs...`, { force: true });
    while (remaining > 0 && !this.isInventoryFull()) {
      this.assertActive();
      if ([...LOG_NAMES].every(name => !bot.registry.blocksByName[name])) {
        throw new Error('This server version has no known log blocks.');
      }
      const positions = bot.findBlocks({
        matching: block => isLog(block.name),
        maxDistance: searchDistance,
        count: Math.min(64, remaining + 24)
      }).filter(position => !visited.has(`${position.x},${position.y},${position.z}`));
      if (positions.length === 0) {
        if (explorations >= 3) break;
        explorations += 1;
        this.progress('No trees in reach; scouting for a forest...', { force: true });
        try {
          await this.explore(autonomous ? 16 : 32);
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
        }
        continue;
      }
      positions.sort((left, right) => bot.entity.position.distanceTo(left) - bot.entity.position.distanceTo(right));
      let choppedThisPass = 0;
      for (const position of positions) {
        if (remaining <= 0) break;
        if (visited.has(`${position.x},${position.y},${position.z}`)) continue;
        const block = bot.blockAt(position);
        if (!block || !isLog(block.name) || !block.diggable) {
          visited.add(`${position.x},${position.y},${position.z}`);
          continue;
        }
        try {
          const base = this.treeBase(bot, block.position);
          await this.goto(
            new GoalNear(base.x, base.y, base.z, 2),
            { timeoutMs: 12000, label: 'Walking to a tree' }
          );
          const chopped = await this.chopReachableLogs(Math.min(remaining, 12));
          if (chopped > 0) {
            choppedBlocks += chopped;
            const pickupDeadline = Date.now() + 2000;
            let currentLogCount = total(this.inventory(), [...LOG_NAMES]);
            while (currentLogCount <= startLogCount + gathered && Date.now() < pickupDeadline) {
              await this.wait(200);
              currentLogCount = total(this.inventory(), [...LOG_NAMES]);
            }
            gathered = Math.max(0, currentLogCount - startLogCount);
            remaining = Math.max(0, requestedCount - gathered);
            choppedThisPass += chopped;
          } else {
            visited.add(`${position.x},${position.y},${position.z}`);
          }
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
          if (error.name === 'TaskAbortedError') throw error;
          visited.add(`${position.x},${position.y},${position.z}`);
        }
        this.progress(`Wood: ${gathered} log(s) in inventory, ${remaining} to go.`);
      }
      if (choppedThisPass === 0) {
        dryPasses += 1;
        if (dryPasses >= 2) break;
        try {
          await this.explore(24);
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
        }
      } else {
        dryPasses = 0;
      }
    }
    const gained = this.inventoryGain(startInventory);
    gathered = Math.max(0, total(this.inventory(), [...LOG_NAMES]) - startLogCount);
    if (gathered === 0) {
      const detail = choppedBlocks > 0
        ? `I chopped ${choppedBlocks} log block(s), but no log drops reached my inventory.`
        : 'I could not find reachable logs nearby, even after scouting.';
      throw new Error(detail);
    }
    this.memory?.recordSkill?.('gatherWood', { success: true, durationMs: 0, detail: `${gathered} logs` });
    this.memory?.setFact?.('lastWoodSite', {
      position: { ...bot.entity.position },
      at: new Date().toISOString()
    });
    return { message: `Collected ${gathered} log(s) into inventory. ${this.describeGain(gained)}`, gained };
  }

  async mine(name, count = 8, { maxDistance = DEFAULT_MINING_DISTANCE } = {}) {
    const bot = this.assertActive();
    const requested = canonicalItem(name);
    const blockNames = this.blockNamesForItem(requested);
    if (blockNames.length === 0) throw new Error(`I do not know which block gives ${requested.replace(/_/g, ' ')}.`);
    const blocks = blockNames.map(blockName => bot?.registry?.blocksByName?.[blockName]).filter(Boolean);
    if (blocks.length === 0 && bot?.registry?.blocksByName) throw new Error(`This server version does not have ${blockNames.join(', ')}.`);
    const autonomous = Boolean(this.agent?.isAutonomousTask);
    if (autonomous) {
      if (bot.health <= 8) throw new Error('Autonomous mining stopped because health is critical.');
      const hostile = Object.values(bot.entities || {}).some(entity => entity?.type === 'mob' &&
        HOSTILE_MOBS.has(entity.name) && entity.position && bot.entity.position.distanceTo(entity.position) <= 12);
      if (hostile) throw new Error('Autonomous mining paused because a hostile mob is within 12 blocks.');
      maxDistance = Math.min(16, Number(maxDistance) || 16);
      count = Math.min(8, Math.max(1, Number(count) || 8));
    }
    let remaining = Math.max(1, Number(count) || 8);
    const requestedCount = remaining;
    let mined = 0;
    let lastFailure = '';
    let explorations = 0;
    let dryPasses = 0;
    const startInventory = this.inventory();

    const requiredTier = requiredPickaxeTier(bot?.registry, blockNames);
    if (requiredTier > 0) {
      const best = bestPickaxe(this.inventory());
      if ((TOOL_TIER[best] || 0) < requiredTier) {
        const requiredPickaxe = PICKAXE_BY_TIER[requiredTier];
        this.progress(`Crafting a ${requiredPickaxe.replace(/_/g, ' ')} before mining ${requested}...`, { force: true });
        await this.ensureItem(requiredPickaxe, 1, 0);
      }
    }
    this.progress(`Mining ${remaining} ${requested.replace(/_/g, ' ')}...`, { force: true });
    while (remaining > 0) {
      this.assertActive();
      const positions = bot.findBlocks({
        matching: block => blocks.some(type => type.id === block.type),
        maxDistance,
        count: Math.min(96, remaining + 24)
      });
      if (positions.length === 0) {
        if (explorations >= 2) break;
        explorations += 1;
        this.progress(`No ${requested.replace(/_/g, ' ')} in reach; scouting...`, { force: true });
        try {
          await this.explore(28);
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
        }
        continue;
      }
      positions.sort((left, right) => bot.entity.position.distanceTo(left) - bot.entity.position.distanceTo(right));
      let minedThisPass = 0;
      for (const position of positions) {
        if (remaining <= 0) break;
        const block = bot.blockAt(position);
        if (!block || (blocks.length ? !blocks.some(type => type.id === block.type) : !blockNames.includes(block.name)) || !block.diggable || block.entity) continue;
        if (autonomous && Math.abs(block.position.y - bot.entity.position.y) > 3) continue;
        if (autonomous) {
          const nearbyHazard = bot.findBlocks({
            matching: candidate => /^(?:lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/.test(candidate?.name || ''),
            maxDistance: 4,
            count: 1
          });
          if (nearbyHazard.length) continue;
        }
        try {
          const targetPosition = `${Math.floor(block.position.x)}, ${Math.floor(block.position.y)}, ${Math.floor(block.position.z)}`;
          this.progress(`Walking to ${block.name.replace(/_/g, ' ')} at ${targetPosition}.`, { force: mined === 0 });
          await this.goto(
            new GoalNear(block.position.x, block.position.y, block.position.z, 1),
            { timeoutMs: 12000, label: 'Walking to a block' }
          );
          const current = bot.blockAt(block.position);
          if (!current || (blocks.length ? !blocks.some(type => type.id === current.type) : !blockNames.includes(current.name))) {
            lastFailure = 'the target block changed before I reached it';
            continue;
          }
          const tool = bot.pathfinder.bestHarvestTool(current);
          if (tool) await this.equipItem(tool.name);
          await withTimeout(bot.dig(current), 15000, 'Mining a block', () => bot.stopDigging?.());
          await this.wait(350);
          remaining -= 1;
          mined += 1;
          minedThisPass += 1;
          if (this.isInventoryFull()) break;
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
          if (error.name === 'TaskAbortedError') throw error;
          lastFailure = String(error?.message || 'pathing or digging failed').slice(0, 160);
          this.progress(`Could not reach or mine that block (${lastFailure}); trying another target.`, { force: true });
        }
      }
      if (minedThisPass === 0) {
        dryPasses += 1;
        if (dryPasses >= 2 || explorations >= 2) break;
        try {
          await this.explore(24);
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
        }
      } else {
        dryPasses = 0;
      }
      this.progress(`Mining: ${mined} done, ${remaining} to go.`);
      if (this.isInventoryFull()) break;
    }
    const gained = this.inventoryGain(startInventory);
    if (mined === 0) {
      const hint = requested === 'iron_ingot' || requested === 'iron_ore'
        ? ' I only see surface blocks; I need to explore a cave or dig a staircase for iron.'
        : '';
      const failure = lastFailure ? ` Last attempt: ${lastFailure}.` : '';
      throw new Error(`I could not find reachable ${blockNames.join(' or ')} within ${maxDistance} blocks.${hint}${failure}`);
    }
    this.memory?.recordSkill?.('mine', {
      success: remaining === 0,
      durationMs: 0,
      detail: `${mined}/${requestedCount} ${requested}${remaining > 0 ? `; ${lastFailure || 'no reachable targets remain'}` : ''}`
    });
    this.memory?.setFact?.(`lastMined:${requested}`, {
      position: { ...bot.entity.position },
      at: new Date().toISOString()
    });
    const partialReason = this.isInventoryFull()
      ? 'my inventory is full'
      : lastFailure || 'no more reachable targets were found';
    const completion = remaining > 0
      ? `Mined ${mined}/${requestedCount} ${requested.replace(/_/g, ' ')}; stopped early because ${partialReason}.`
      : `Mined ${mined} ${requested.replace(/_/g, ' ')}.`;
    this.progress(completion, { force: true });
    return { message: `${completion} ${this.describeGain(gained)}`, gained, mined, requested: requestedCount, partial: remaining > 0 };
  }

  blockNamesForItem(item) {
    const requested = canonicalItem(item);
    if (this.bot?.registry?.blocksByName?.[requested]) return [requested];
    if (isLog(requested)) return [...LOG_NAMES];
    switch (requested) {
      case 'stone':
      case 'cobblestone': return ['stone'];
      case 'coal':
      case 'coal_ore': return ['coal_ore', 'deepslate_coal_ore'];
      case 'iron_ore':
      case 'raw_iron':
      case 'iron_ingot': return ['iron_ore', 'deepslate_iron_ore'];
      case 'gold_ore':
      case 'raw_gold':
      case 'gold_ingot': return ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'];
      case 'diamond':
      case 'diamond_ore': return ['diamond_ore', 'deepslate_diamond_ore'];
      case 'copper_ore':
      case 'copper_ingot': return ['copper_ore', 'deepslate_copper_ore'];
      case 'redstone':
      case 'redstone_ore': return ['redstone_ore', 'deepslate_redstone_ore'];
      case 'lapis_lazuli':
      case 'lapis_ore': return ['lapis_ore', 'deepslate_lapis_ore'];
      case 'emerald':
      case 'emerald_ore': return ['emerald_ore', 'deepslate_emerald_ore'];
      case 'dirt': return ['dirt', 'grass_block'];
      case 'sand': return ['sand'];
      case 'gravel': return ['gravel'];
      case 'wheat': return ['wheat'];
      case 'carrot': return ['carrots'];
      case 'potato': return ['potatoes'];
      case 'white_wool': return [];
      case 'book': return ['bookshelf'];
      case 'bookshelf': return ['bookshelf'];
      default: return [];
    }
  }

  requiresPickaxe(item) {
    const normalized = canonicalItem(item);
    if (isLog(normalized) || ['dirt', 'sand', 'gravel', 'food', 'wheat', 'carrot', 'potato', 'white_wool'].includes(normalized)) return false;
    const blocks = this.blockNamesForItem(normalized)
      .map(name => this.bot?.registry?.blocksByName?.[name])
      .filter(Boolean);
    if (blocks.length === 0) return true;
    return blocks.some(block => Object.keys(block.harvestTools || {})
      .some(id => (this.bot?.registry?.items?.[id]?.name || '').endsWith('_pickaxe')));
  }

  isInventoryFull() {
    const bot = this.bot;
    if (!bot?.inventory?.items) return false;
    const items = bot.inventory.items();
    if (items.length < 36) return false;
    return items.every(item => item.count >= 64);
  }

  inventoryGain(before) {
    const after = this.inventory();
    const gained = {};
    for (const [name, count] of Object.entries(after)) {
      const delta = count - (before[name] || 0);
      if (delta > 0) gained[name] = delta;
    }
    return gained;
  }

  describeGain(gained) {
    const text = formatInventory(gained, 6);
    return text === 'empty' ? 'No drops were collected.' : `Collected ${text}.`;
  }

  async gatherFood(count = 8) {
    const bot = this.assertActive();
    if (this.hasItem('food') && Number(bot.food) <= 6) {
      const eaten = await this.eat();
      if (eaten) return eaten;
    }
    let hunted = 0;
    const animals = Object.values(bot.entities || {})
      .filter(entity => ANIMALS.has(entity.name) && entity.position &&
        bot.entity.position.distanceTo(entity.position) <= 32)
      .sort((left, right) =>
        bot.entity.position.distanceTo(left.position) - bot.entity.position.distanceTo(right.position));
    if (animals.length) {
      this.progress(`Hunting ${Math.min(animals.length, count)} animals...`, { force: true });
      for (const animal of animals.slice(0, count)) {
        if (hunted >= count) break;
        try {
          await this.attackEntity(animal, { maxDistance: 32 });
          hunted += 1;
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
        }
      }
      if (hunted > 0) {
        await this.wait(800);
        this.progress(`Hunted ${hunted} animal(s).`, { force: true });
        return { message: `Hunted ${hunted} animal(s).` };
      }
    }
    const harvested = await this.harvestCrops();
    if (harvested > 0) return { message: `Harvested ${harvested} crop(s).` };
    throw new Error('I could not find animals or mature crops nearby.');
  }

  async gatherWool(count = 3) {
    const bot = this.assertActive();
    const sheep = Object.values(bot.entities || {})
      .filter(entity => entity.name === 'sheep' && entity.position &&
        bot.entity.position.distanceTo(entity.position) <= 32)
      .sort((left, right) =>
        bot.entity.position.distanceTo(left.position) - bot.entity.position.distanceTo(right.position));
    let killed = 0;
    for (const entity of sheep.slice(0, Math.max(2, count))) {
      if (this.countItem('white_wool') >= count) break;
      try {
        await this.attackEntity(entity, { maxDistance: 32 });
        killed += 1;
        await this.wait(500);
      } catch (error) {
        if (error instanceof TaskAbortedError) throw error;
      }
    }
    if (this.countItem('white_wool') < count) {
      throw new Error(`I only collected ${this.countItem('white_wool')} wool.`);
    }
    return { message: `Collected ${this.countItem('white_wool')} wool from ${killed} sheep.` };
  }

  async attackNearest(target = null) {
    const bot = this.assertActive();
    const normalized = target ? canonicalItem(target) : null;
    const candidates = Object.values(bot.entities || {})
      .filter(entity => entity?.type === 'mob' && entity?.position && entity !== bot.entity && HOSTILE_MOBS.has(entity.name))
      .filter(entity => !normalized || entity.name === normalized || entity.name.includes(normalized))
      .sort((left, right) =>
        bot.entity.position.distanceTo(left.position) - bot.entity.position.distanceTo(right.position));
    if (candidates.length === 0) {
      if (normalized && ANIMALS.has(normalized)) return this.huntMob(normalized, 1);
      return { message: 'No hostile mobs nearby.' };
    }
    const targetEntity = candidates[0];
    await this.attackEntity(targetEntity, { maxDistance: 24 });
    return { message: `Fought a ${targetEntity.name}.` };
  }

  async huntMob(name, count = 1) {
    const bot = this.assertActive();
    const normalized = canonicalItem(name);
    if (!HOSTILE_MOBS.has(normalized) && !ANIMALS.has(normalized)) {
      throw new Error(`I do not hunt ${normalized.replace(/_/g, ' ')}; I only hunt known mobs and food animals.`);
    }
    const wanted = Math.max(1, Math.min(Number(count) || 1, 32));
    let hunted = 0;
    for (let attempt = 0; attempt < wanted * 4 && hunted < wanted; attempt += 1) {
      const candidates = Object.values(bot.entities || {})
        .filter(entity => entity?.type === 'mob' && entity?.position && entity !== bot.entity &&
          entity.name === normalized && entity.health !== 0)
        .sort((left, right) =>
          bot.entity.position.distanceTo(left.position) - bot.entity.position.distanceTo(right.position));
      const target = candidates[0];
      if (!target) break;
      const entityId = target.id;
      try {
        await this.attackEntity(target, { maxDistance: 32 });
      } catch (error) {
        if (error instanceof TaskAbortedError) throw error;
        this.progress(`Hunt paused: ${error.message}`, { force: true });
        continue;
      }
      await this.wait(500);
      const lingering = entityId !== undefined ? bot.entities?.[entityId] : null;
      if (!lingering || lingering.health === 0 || lingering.dead) hunted += 1;
    }
    if (hunted === 0) throw new Error(`I could not reach or defeat any ${normalized.replace(/_/g, ' ')} nearby.`);
    return { message: `Hunted ${hunted} ${normalized.replace(/_/g, ' ')}.` };
  }

  async breedAnimal(name, count = 2) {
    const bot = this.assertActive();
    const normalized = canonicalItem(name);
    const food = BREED_FOODS[normalized];
    if (!food) throw new Error(`I do not know how to breed ${normalized.replace(/_/g, ' ')}.`);
    const wanted = Math.max(2, Math.min(Number(count) || 2, 24));
    const findAnimals = () => Object.values(bot.entities || {})
      .filter(entity => entity?.type === 'mob' && entity?.position && entity !== bot.entity &&
        entity.name === normalized)
      .sort((left, right) =>
        bot.entity.position.distanceTo(left.position) - bot.entity.position.distanceTo(right.position));
    const animals = findAnimals();
    if (animals.length < 2) {
      throw new Error(`I need two ${normalized.replace(/_/g, ' ')} within reach; I only see ${animals.length}.`);
    }
    if (!this.hasItem(food, 1)) {
      try {
        await this.ensureItem(food, 2);
      } catch {
        // The food may not be gatherable automatically.
      }
    }
    if (!this.hasItem(food, 1)) {
      throw new Error(`I need ${food.replace(/_/g, ' ')} to breed ${normalized.replace(/_/g, ' ')}.`);
    }
    const pairs = Math.floor(Math.min(animals.length, wanted) / 2);
    let bred = 0;
    for (let pair = 0; pair < pairs; pair += 1) {
      this.assertActive();
      const current = findAnimals();
      const first = current[pair * 2];
      const second = current[pair * 2 + 1];
      if (!first || !second) break;
      const knownIds = new Set(current.map(entity => entity.id));
      await this.equipItem(food);
      try {
        await this.goto(new GoalNear(first.position.x, first.position.y, first.position.z, 2));
        await bot.activateEntity(first);
        await this.wait(600);
        await this.equipItem(food);
        await this.goto(new GoalNear(second.position.x, second.position.y, second.position.z, 2));
        await bot.activateEntity(second);
      } catch (error) {
        if (error instanceof TaskAbortedError) throw error;
        this.progress(`Breeding pair skipped: ${error.message}`, { force: true });
        continue;
      }
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        this.assertActive();
        const baby = findAnimals().find(entity => !knownIds.has(entity.id));
        if (baby) {
          bred += 1;
          break;
        }
        await this.wait(500);
      }
    }
    if (bred === 0) {
      throw new Error(`I fed the ${normalized.replace(/_/g, ' ')} but no baby appeared; they may already be on cooldown.`);
    }
    return { message: `Bred ${bred} pair(s) of ${normalized.replace(/_/g, ' ')}.` };
  }

  async defend() {
    return this.attackNearest();
  }

  async attackEntity(entity, { maxDistance = 16 } = {}) {
    const bot = this.assertActive();
    if (!entity || entity.type !== 'mob' || !entity.position ||
      (!HOSTILE_MOBS.has(entity.name) && !ANIMALS.has(entity.name))) {
      throw new Error('I can only attack a visible hostile mob or a food animal, never a player or unknown entity.');
    }
    if (entity.id !== undefined && bot.entities?.[entity.id] !== entity) {
      throw new Error('That target is no longer a live nearby entity.');
    }
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > maxDistance) throw new Error(`The ${entity.name} is too far away (${Math.round(distance)} blocks).`);
    if (entity.name === 'creeper') {
      await this.fleeFrom(entity);
      return { message: 'Retreated from the creeper instead of trading hits.' };
    }
    await this.equipBestArmor();
    await this.equipBestSword();
    const shield = this.findInventoryItem('shield');
    if (shield && typeof bot.equip === 'function') {
      try { await bot.equip(shield, 'off-hand'); } catch {}
    }
    this.progress(`Fighting ${entity.name}...`, { force: true });
    let lastAttack = 0;
    for (let round = 0; round < 60; round += 1) {
      this.assertActive();
      const current = bot.entities?.[entity.id];
      if (!current || current !== entity || current.type !== 'mob' || current.health === 0 || !current.position) break;
      if (bot.health <= 8) {
        await this.fleeFrom(current);
        throw new Error('I retreated because my health was low.');
      }
      const targetDistance = bot.entity.position.distanceTo(current.position);
      if (targetDistance > 3) {
        try {
          await this.goto(new GoalNear(current.position.x, current.position.y, current.position.z, 2));
        } catch {
          // If pathfinding fails, still try to hit if close enough.
        }
      }
      if (bot.entity.position.distanceTo(current.position) <= 4 && Date.now() - lastAttack >= 620) {
        if (bot.entity?.onGround && typeof bot.setControlState === 'function') {
          bot.setControlState('jump', true);
          setTimeout(() => { if (typeof bot.setControlState === 'function') bot.setControlState('jump', false); }, 120);
        }
        bot.attack(current);
        lastAttack = Date.now();
      }
      await this.wait(180);
    }
    return { message: `Finished fighting ${entity.name}.` };
  }

  async fleeFrom(hostile) {
    const bot = this.assertActive();
    const position = bot.entity.position;
    let dx = position.x - hostile.position.x;
    let dz = position.z - hostile.position.z;
    let length = Math.hypot(dx, dz);
    if (length === 0) {
      dx = 1;
      dz = 0;
      length = 1;
    }
    const target = new GoalNear(
      Math.floor(position.x + (dx / length) * 12),
      Math.floor(position.y),
      Math.floor(position.z + (dz / length) * 12),
      2
    );
    await this.goto(target);
    return { message: `Retreated from the ${hostile.name}.` };
  }

  async survive() {
    const bot = this.assertActive();
    const observation = this.observation();
    const hostile = observation.nearbyHostiles[0];
    if (bot.health <= 10) {
      if (this.hasItem('food')) {
        await this.eat();
        return { message: 'Ate food to recover health.' };
      }
      if (hostile) {
        const entity = Object.values(bot.entities || {}).find(entry => entry.name === hostile.name);
        if (entity) {
          await this.fleeFrom(entity);
          return { message: 'Retreated from danger.' };
        }
      }
      return { message: 'Health is low; staying defensive.' };
    }
    if (hostile) {
      const entity = Object.values(bot.entities || {}).find(entry =>
        entry.name === hostile.name && entry.position &&
        Math.round(bot.entity.position.distanceTo(entry.position)) === hostile.distance);
      if (entity) {
        await this.attackEntity(entity);
        return { message: `Defended against a ${hostile.name}.` };
      }
    }
    return { message: 'No immediate danger.' };
  }

  async eat() {
    const bot = this.assertActive();
    if (Number(bot.food) >= 18 && Number(bot.health) >= 18) return { message: 'I am full and healthy.' };

    const saturationRank = {
      enchanted_golden_apple: 200,
      golden_apple: 100,
      golden_carrot: 90,
      cooked_beef: 80,
      cooked_porkchop: 80,
      cooked_mutton: 70,
      cooked_salmon: 70,
      cooked_chicken: 60,
      baked_potato: 60,
      bread: 50,
      cooked_cod: 50,
      apple: 30,
      carrot: 30
    };

    const heldBefore = bot.heldItem ? bot.heldItem.name : null;
    const items = bot.inventory?.items ? bot.inventory.items() : [];

    // Low health priority: eat golden apple or healing food if available
    let chosenFood = null;
    if (Number(bot.health) <= 12) {
      chosenFood = items.find(it => it.name === 'golden_apple' || it.name === 'enchanted_golden_apple');
    }

    if (!chosenFood) {
      chosenFood = items
        .filter(item => FOOD_NAMES.has(item.name))
        .sort((left, right) => (saturationRank[right.name] || 10) - (saturationRank[left.name] || 10))[0];
    }

    if (!chosenFood) return { message: 'I do not have any food.' };
    await this.equipItem(chosenFood.name);
    this.progress(`Eating ${chosenFood.name.replace(/_/g, ' ')}...`, { force: true });
    await withTimeout(bot.consume(), 8000, 'Eating');
    await this.wait(300);

    if (heldBefore && heldBefore !== chosenFood.name) {
      try { await this.equipItem(heldBefore); } catch {}
    }

    return { message: `Ate ${chosenFood.name.replace(/_/g, ' ')}. Food is now ${bot.food}/20, health is ${bot.health}/20.` };
  }

  async ensureFurnace() {
    const bot = this.assertActive();
    let furnace = bot.findBlock({
      matching: block => block.name === 'furnace' || block.name === 'blast_furnace' || block.name === 'smoker',
      maxDistance: 8
    });
    if (furnace) return furnace;
    await this.ensureItem('furnace', 1);
    await this.equipItem('furnace');
    const base = bot.entity.position.floored();
    for (let radius = 1; radius <= 3; radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          const support = bot.blockAt(base.offset(dx, -1, dz));
          const target = bot.blockAt(base.offset(dx, 0, dz));
          if (!support || support.boundingBox !== 'block' || !target || target.name !== 'air') continue;
          if (Math.abs(support.position.x + 0.5 - bot.entity.position.x) < 0.9 &&
            Math.abs(support.position.z + 0.5 - bot.entity.position.z) < 0.9) continue;
          try {
            await this.equipItem('furnace');
            await withTimeout(bot.placeBlock(support, new Vec3(0, 1, 0)), 8000, 'Placing a block');
            await this.wait(250);
            const placed = bot.blockAt(support.position.offset(0, 1, 0));
            if (placed?.name === 'furnace' || placed?.name === 'blast_furnace') return placed;
          } catch {
            // Try the next spot.
          }
        }
      }
    }
    throw new Error('I could not place a furnace nearby.');
  }

  smeltOutput(item) {
    const normalized = canonicalItem(item);
    if (normalized === 'iron_ingot') return { input: ['raw_iron', 'iron_ore'], output: 'iron_ingot' };
    if (normalized === 'gold_ingot') return { input: ['raw_gold', 'gold_ore'], output: 'gold_ingot' };
    if (normalized === 'copper_ingot') return { input: ['raw_copper', 'copper_ore'], output: 'copper_ingot' };
    if (normalized === 'charcoal') return { input: [...LOG_NAMES], output: 'charcoal' };
    if (normalized === 'glass') return { input: ['sand'], output: 'glass' };
    if (normalized === 'stone') return { input: ['cobblestone'], output: 'stone' };
    if (RAW_TO_COOKED[normalized]) return { input: [normalized], output: RAW_TO_COOKED[normalized] };
    if (COOKED_FOOD.has(normalized)) {
      const raw = Object.entries(RAW_TO_COOKED).find(([, cooked]) => cooked === normalized)?.[0];
      if (raw) return { input: [raw], output: normalized };
    }
    return { input: [], output: normalized };
  }

  async smelt(item, count = 8) {
    const bot = this.assertActive();
    const normalized = canonicalItem(item);
    const { input, output } = this.smeltOutput(normalized);
    if (!input.length) throw new Error(`I do not know how to smelt ${normalized.replace(/_/g, ' ')}.`);
    if (output === 'charcoal') {
      if (this.countItem('charcoal') >= count) return { message: `I already have ${this.countItem('charcoal')} charcoal.` };
      if (!this.findInventoryItem('oak_log')) await this.gatherWood(Math.max(4, count));
    } else if (this.countItem(output) >= count) {
      return { message: `I already have ${this.countItem(output)} ${output.replace(/_/g, ' ')}.` };
    }
    const source = input.find(name => this.countItem(name) > 0);
    if (!source) {
      if (input.some(name => name.endsWith('_ore') || name.startsWith('raw_'))) {
        await this.mine(input[0], count);
      } else if (input.some(name => isLog(name))) {
        await this.gatherWood(Math.max(4, count));
      } else {
        await this.gatherFood(count);
      }
    }
    const available = input.reduce((sum, name) => sum + this.countItem(name), 0);
    if (available < 1) throw new Error(`I do not have any ${input[0].replace(/_/g, ' ')} to smelt.`);
    const furnaceBlock = await this.ensureFurnace();
    const furnace = await withTimeout(bot.openFurnace(furnaceBlock), 12000, 'Opening the furnace');
    try {
      const inputItem = input.map(name => this.findInventoryItem(name)).find(Boolean);
      if (!inputItem) throw new Error('The smelting input disappeared.');
      const amount = Math.min(count, available);
      const fuel = this.findFuel();
      if (!fuel) throw new Error('I do not have fuel (coal, charcoal, planks, or logs).');
      this.progress(`Smelting ${amount} ${inputItem.name.replace(/_/g, ' ')}...`, { force: true });
      await furnace.putFuel(fuel.id, null, Math.max(1, Math.ceil(amount / 8)));
      await furnace.putInput(inputItem.type, null, amount);
      const deadline = Date.now() + Math.max(15000, amount * 12000);
      let outputItem = null;
      while (Date.now() < deadline) {
        this.assertActive();
        outputItem = furnace.outputItem();
        if (outputItem && outputItem.count >= amount) break;
        if (furnace.outputItem() && furnace.outputItem().count > 0 && !furnace.inputItem()) break;
        await this.wait(500);
      }
      outputItem = furnace.outputItem();
      if (!outputItem) throw new Error('The furnace produced no output; it may need more fuel.');
      await furnace.takeOutput();
      await this.wait(250);
      this.progress(`Smelted ${normalized.replace(/_/g, ' ')}.`, { force: true });
      return { message: `Smelted ${outputItem.count} ${outputItem.name.replace(/_/g, ' ')}.` };
    } finally {
      try {
        furnace.close();
      } catch {
        // The window may already be closed.
      }
    }
  }

  findFuel() {
    const bot = this.assertActive();
    return ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick']
      .map(name => this.findInventoryItem(name))
      .find(Boolean) || null;
  }

  async sleep() {
    const bot = this.assertActive();
    if (bot.time?.isDay !== false) return { message: 'It is not clearly nighttime; I will wait rather than attempt sleep.' };
    if (bot.health <= 8 || bot.food <= 4) throw new Error('Sleeping is unsafe while health or hunger is critical.');
    const nearbyHostile = Object.values(bot.entities || {})
      .find(entity => entity?.type === 'mob' && HOSTILE_MOBS.has(entity.name) && entity.position &&
        bot.entity.position.distanceTo(entity.position) <= 8);
    if (nearbyHostile) throw new Error(`I will not sleep while a ${nearbyHostile.name} is within 8 blocks.`);
    let bed = bot.findBlock?.({
      matching: block => block.name.endsWith('_bed'),
      maxDistance: 32
    });
    if (!bed) {
      if (this.findInventoryItem('bed')) {
        await this.equipItem('bed');
        const base = bot.entity.position.floored();
        const airNames = new Set(['air', 'cave_air', 'void_air']);
        const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let radius = 1; radius <= 2; radius += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dz = -radius; dz <= radius; dz += 1) {
              const targetPosition = base.offset(dx, 0, dz);
              const support = bot.blockAt(targetPosition.offset(0, -1, 0));
              const target = bot.blockAt(targetPosition);
              if (!support || support.boundingBox !== 'block' || !target || !airNames.has(target.name)) continue;
              const allDirectionsClear = directions.every(([sideX, sideZ]) => {
                const headPosition = targetPosition.offset(sideX, 0, sideZ);
                const head = bot.blockAt(headPosition);
                const headSupport = bot.blockAt(headPosition.offset(0, -1, 0));
                return head && airNames.has(head.name) && headSupport?.boundingBox === 'block';
              });
              if (!allDirectionsClear) continue;
              try {
                await withTimeout(bot.placeBlock(support, new Vec3(0, 1, 0)), 8000, 'Placing a bed');
                await this.wait(250);
                const placed = bot.blockAt(targetPosition);
                if (placed?.name.endsWith('_bed')) bed = placed;
              } catch {
                // Try another spot.
              }
            }
            if (bed) break;
          }
          if (bed) break;
        }
      } else {
        throw new Error('No bed is nearby or in my inventory. I will not hunt for wool at night.');
      }
    }
    if (!bed) throw new Error('I could not find or place a bed.');
    await this.goto(new GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
    await withTimeout(bot.sleep(bed), 300000, 'Sleeping', () => bot.wake?.());
    this.progress('Sleeping until morning.', { force: true });
    return { message: 'I am sleeping until morning.' };
  }

  async buildShelter() {
    const bot = this.assertActive();
    const materials = ['cobblestone', 'dirt', 'oak_planks', 'birch_planks', 'spruce_planks', 'stone']
      .map(name => this.findInventoryItem(name))
      .find(Boolean);
    if (!materials) {
      await this.mine('stone', 32);
    }
    const blockItem = this.findInventoryItem('cobblestone') || this.findInventoryItem('dirt') ||
      this.findInventoryItem('oak_planks') || this.findInventoryItem('stone');
    if (!blockItem) throw new Error('I need building blocks for a shelter.');
    const needed = 26;
    const available = this.countItem(blockItem.name);
    if (available < needed) {
      try {
        await this.mine(blockItem.name === 'cobblestone' ? 'stone' : blockItem.name, needed - available);
      } catch {
        // Use what we have.
      }
    }
    const base = bot.entity.position.floored();
    const center = base.offset(0, 0, 0);
    const positions = [];
    for (let y = 0; y <= 2; y += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (y < 2 && dx === 0 && dz === 0) continue;
          positions.push({ dx, dy: y, dz });
        }
      }
    }
    this.progress('Building a shelter...', { force: true });
    let placed = 0;
    for (const offset of positions) {
      this.assertActive();
      const targetPosition = center.offset(offset.dx, offset.dy, offset.dz);
      const existing = bot.blockAt(targetPosition);
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air') continue;
      let reference = null;
      let face = null;
      if (offset.dy > 0) {
        const below = bot.blockAt(targetPosition.offset(0, -1, 0));
        if (below && below.boundingBox === 'block') {
          reference = below;
          face = new Vec3(0, 1, 0);
        }
      } else {
        const below = bot.blockAt(targetPosition.offset(0, -1, 0));
        if (below && below.boundingBox === 'block') {
          reference = below;
          face = new Vec3(0, 1, 0);
        }
      }
      if (!reference) continue;
      try {
        await this.equipItem(blockItem.name);
        await withTimeout(bot.placeBlock(reference, face), 8000, 'Placing a block');
        await this.wait(150);
        placed += 1;
      } catch {
        // Keep building the rest.
      }
    }
    if (placed === 0) throw new Error('I could not place shelter blocks here.');
    const torch = this.findInventoryItem('torch');
    if (torch) {
      try {
        await this.equipItem('torch');
        const support = bot.blockAt(center.offset(0, -1, 0));
        if (support) {
          await withTimeout(bot.placeBlock(support, new Vec3(0, 1, 0)), 8000, 'Placing a block');
        }
      } catch {
        // Light is optional.
      }
    }
    this.memory?.setFact?.('shelter', {
      position: { x: center.x, y: center.y, z: center.z },
      at: new Date().toISOString()
    });
    this.progress(`Shelter built with ${placed} blocks.`, { force: true });
    return { message: `Built a shelter with ${placed} blocks at ${formatPosition({ position: center })}.` };
  }

  async harvestCrops() {
    const bot = this.assertActive();
    const cropTypes = ['wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin', 'melon', 'sugar_cane'];
    const positions = bot.findBlocks({
      matching: block => cropTypes.includes(block?.name),
      maxDistance: 32,
      count: 64
    });
    let harvested = 0;
    for (const position of positions) {
      this.assertActive();
      const block = bot.blockAt(position);
      if (!block || !cropTypes.includes(block.name)) continue;

      // Maturity check
      if (['wheat', 'carrots', 'potatoes', 'beetroots'].includes(block.name)) {
        if (block.metadata !== undefined && block.metadata < 7) continue;
      }
      if (block.name === 'sugar_cane') {
        const below = bot.blockAt(position.offset(0, -1, 0));
        // Only harvest if it's the upper stalk (preserve base stalk for continuous growth)
        if (!below || below.name !== 'sugar_cane') continue;
      }

      try {
        await this.goto(new GoalNear(block.position.x, block.position.y, block.position.z, 1));
        const current = bot.blockAt(block.position);
        if (!current) continue;
        const cropName = current.name;
        await withTimeout(bot.dig(current), 15000, 'Harvesting crop', () => bot.stopDigging?.());
        harvested += 1;
        await this.wait(150);

        // Immediate replant on the farmland beneath
        const soil = bot.blockAt(block.position.offset(0, -1, 0));
        if (soil && soil.name === 'farmland') {
          const seedMap = {
            wheat: 'wheat_seeds',
            carrots: 'carrot',
            potatoes: 'potato',
            beetroots: 'beetroot_seeds'
          };
          const seedItemName = seedMap[cropName];
          if (seedItemName && this.findInventoryItem(seedItemName)) {
            await this.equipItem(seedItemName);
            await withTimeout(bot.placeBlock(soil, new Vec3(0, 1, 0)), 6000, 'Replanting crop');
            await this.wait(100);
          }
        }
      } catch (error) {
        if (error instanceof TaskAbortedError) throw error;
      }
    }
    return harvested;
  }

  async farm() {
    const bot = this.assertActive();
    const harvested = await this.harvestCrops();
    let planted = 0;

    // Scan for unplanted farmland and plant matching seeds
    const seedOptions = [
      { seed: 'wheat_seeds', crop: 'wheat' },
      { seed: 'carrot', crop: 'carrots' },
      { seed: 'potato', crop: 'potatoes' },
      { seed: 'beetroot_seeds', crop: 'beetroots' }
    ];

    const farmlands = bot.findBlocks({
      matching: block => block?.name === 'farmland',
      maxDistance: 24,
      count: 32
    });

    for (const position of farmlands) {
      this.assertActive();
      const above = bot.blockAt(position.offset(0, 1, 0));
      if (!above || above.name !== 'air') continue;

      const availableSeed = seedOptions.find(opt => this.findInventoryItem(opt.seed));
      if (!availableSeed) break;

      try {
        await this.goto(new GoalNear(position.x, position.y, position.z, 2));
        await this.equipItem(availableSeed.seed);
        const current = bot.blockAt(position);
        const target = bot.blockAt(position.offset(0, 1, 0));
        if (!current || current.name !== 'farmland' || !target || target.name !== 'air') continue;
        await withTimeout(bot.placeBlock(current, new Vec3(0, 1, 0)), 8000, 'Planting crop');
        planted += 1;
        await this.wait(120);
      } catch (error) {
        if (error instanceof TaskAbortedError) throw error;
      }
    }

    // Auto-craft bread if surplus wheat is available
    let breadCrafted = 0;
    const wheatCount = this.countItem('wheat');
    if (wheatCount >= 3) {
      try {
        const breadBatches = Math.floor(wheatCount / 3);
        const res = await this.ensureItem('bread', breadBatches);
        if (res) breadCrafted = breadBatches;
      } catch {
        // Crafting bread is bonus
      }
    }

    if (harvested === 0 && planted === 0) {
      throw new Error('I could not find mature crops or open farmland nearby.');
    }
    const breadMsg = breadCrafted > 0 ? ` Crafted ${breadCrafted} bread.` : '';
    return { message: `Harvested ${harvested} crop(s) and replanted ${planted}.${breadMsg}` };
  }

  async deliverToPlayer(item, count, player = 'requester') {
    const bot = this.assertActive();
    const targetName = player === 'requester' ? this.agent?.requestedBy : player;
    if (!targetName) throw new Error('I do not know who to deliver to.');
    const normalized = canonicalItem(item);
    const amount = Math.max(1, Math.min(Number(count) || 1, 64));
    if (this.countItem(normalized) < amount) {
      await this.ensureItem(normalized, amount);
    }
    if (this.countItem(normalized) < amount) {
      throw new Error(`I could only obtain ${this.countItem(normalized)} ${normalized.replace(/_/g, ' ')}.`);
    }
    const entity = this.playerEntity(targetName);
    if (!entity) throw new Error(`${targetName} is not visible to me right now.`);
    if (bot.entity.position.distanceTo(entity.position) > 32) {
      await this.comeToPlayer(targetName);
    }
    const itemType = bot.registry.itemsByName[normalized];
    if (!itemType) throw new Error(`Unknown item: ${normalized}`);
    const current = this.playerEntity(targetName);
    if (!current || bot.entity.position.distanceTo(current.position) > 4) {
      throw new Error(`${targetName} moved out of delivery range.`);
    }
    await bot.toss(itemType.id, null, amount);
    this.progress(`Delivered ${amount} ${normalized.replace(/_/g, ' ')}.`, { force: true });
    return { message: `Delivered ${amount} ${normalized.replace(/_/g, ' ')} to ${targetName}.` };
  }

  async setWaypoint(name = 'home') {
    const bot = this.assertActive();
    this.memory?.addWaypoint?.(name, bot.entity.position, { kind: 'manual' });
    return { message: `Saved waypoint ${name} at ${formatPosition({ position: bot.entity.position })}.` };
  }

  async dropItem(name = null, count = null) {
    const bot = this.assertActive();
    if (!name && !count) {
      const held = bot.heldItem;
      if (!held) return { message: 'I have no item in hand to drop.' };
      await bot.toss(held.type, null, 1);
      return { message: `Dropped 1 ${held.name.replace(/_/g, ' ')}.`, item: held.name, count: 1 };
    }
    const targetItem = name ? canonicalItem(name) : (bot.heldItem?.name || null);
    if (!targetItem) throw new Error('Specify an item or hold an item to drop.');
    const itemObj = this.findInventoryItem(targetItem);
    if (!itemObj) throw new Error(`I do not have any ${targetItem.replace(/_/g, ' ')} to drop.`);
    const itemType = bot.registry.itemsByName?.[itemObj.name];
    if (!itemType) throw new Error(`Unknown item: ${targetItem}`);
    const amount = count ? Math.min(Number(count) || 1, itemObj.count) : 1;
    await bot.toss(itemType.id, null, amount);
    return { message: `Dropped ${amount} ${itemObj.name.replace(/_/g, ' ')}.`, item: itemObj.name, count: amount };
  }

  async lookAtTarget(target) {
    const bot = this.assertActive();
    if (!target) return { message: 'No target specified.' };
    const lower = String(target).toLowerCase();
    if (lower === 'me' || lower === 'requester') {
      const playerEntity = this.playerEntity('requester');
      if (playerEntity) {
        await bot.lookAt(playerEntity.position.offset(0, 1.6, 0), true);
        return { message: 'Looking right at you.' };
      }
      throw new Error('You are not visible to me right now.');
    }
    if (lower === 'up') {
      await bot.look(bot.entity.yaw, Math.PI / 2, true);
      return { message: 'Looking straight up.' };
    }
    if (lower === 'down') {
      await bot.look(bot.entity.yaw, -Math.PI / 2, true);
      return { message: 'Looking straight down.' };
    }
    if (lower === 'north') {
      await bot.look(Math.PI, 0, true);
      return { message: 'Looking north.' };
    }
    if (lower === 'south') {
      await bot.look(0, 0, true);
      return { message: 'Looking south.' };
    }
    if (lower === 'east') {
      await bot.look(-Math.PI / 2, 0, true);
      return { message: 'Looking east.' };
    }
    if (lower === 'west') {
      await bot.look(Math.PI / 2, 0, true);
      return { message: 'Looking west.' };
    }
    const playerEntity = this.playerEntity(target);
    if (playerEntity) {
      await bot.lookAt(playerEntity.position.offset(0, 1.6, 0), true);
      return { message: `Looking at ${target}.` };
    }
    return { message: `Could not find ${target} to look at.` };
  }

  async selectSlot(slot) {
    const bot = this.assertActive();
    const slotIdx = Math.max(0, Math.min(8, (Number(slot) || 1) - 1));
    bot.setQuickBarSlot(slotIdx);
    const held = bot.heldItem;
    return { message: `Selected hotbar slot ${slotIdx + 1}${held ? ` (${held.name.replace(/_/g, ' ')})` : ''}.`, slot: slotIdx + 1 };
  }

  async swingArm() {
    const bot = this.assertActive();
    bot.swingArm('right');
    const target = bot.entityAtCursor ? bot.entityAtCursor(3.5) : null;
    if (target) {
      bot.attack(target);
      return { message: `Swung and attacked ${target.name || target.username}.` };
    }
    return { message: 'Swung arm.' };
  }

  async useHeldItem() {
    const bot = this.assertActive();
    const block = bot.blockAtCursor ? bot.blockAtCursor(4.5) : null;
    if (block) {
      await bot.activateBlock(block);
      return { message: `Interacted with ${block.name}.` };
    }
    bot.activateItem();
    return { message: 'Used held item.' };
  }

  async gotoWaypoint(name = 'home') {
    const bot = this.assertActive();
    const waypoint = this.memory?.getWaypoint?.(name);
    if (!waypoint) throw new Error(`I do not know a waypoint named ${name}.`);
    await this.goto(new GoalNear(waypoint.x, waypoint.y, waypoint.z, 2));
    return { message: `Arrived at ${name}.` };
  }

  async withdrawItem(name, count = 64) {
    const bot = this.assertActive();
    const normalized = canonicalItem(name);
    const itemType = bot.registry.itemsByName?.[normalized];
    if (!itemType) throw new Error(`Unknown item: ${normalized.replace(/_/g, ' ')}.`);
    const chestBlock = bot.findBlock({
      matching: block => block?.name === 'chest' || block?.name === 'barrel' || block?.name === 'trapped_chest',
      maxDistance: 16
    });
    if (!chestBlock) throw new Error('I could not find a chest within 16 blocks.');
    const amount = Math.max(1, Math.min(Number(count) || 1, 64 * 6));
    const chest = await withTimeout(bot.openChest(chestBlock), 8000, 'Opening the chest');
    let taken = 0;
    try {
      const stacks = chest.containerItems()
        .filter(item => item?.name === normalized)
        .sort((left, right) => (left.count || 0) - (right.count || 0));
      for (const stack of stacks) {
        if (taken >= amount) break;
        const take = Math.min(stack.count, amount - taken);
        await chest.withdraw(stack.type, null, take);
        taken += take;
      }
      if (taken === 0) throw new Error(`The chest has no ${normalized.replace(/_/g, ' ')}.`);
      this.progress(`Withdrew ${taken} ${normalized.replace(/_/g, ' ')}.`, { force: true });
      return { message: `Withdrew ${taken} ${normalized.replace(/_/g, ' ')} from the chest.` };
    } finally {
      chest.close();
    }
  }

  pickTunnelDirection(bot) {
    const origin = bot.entity.position.floored();
    const axes = {
      north: { x: 0, z: -1 },
      south: { x: 0, z: 1 },
      east: { x: 1, z: 0 },
      west: { x: -1, z: 0 }
    };
    let best = 'north';
    let bestScore = -Infinity;
    for (const [name, axis] of Object.entries(axes)) {
      let score = 0;
      for (let step = 1; step <= 4; step += 1) {
        for (const dy of [0, 1]) {
          const position = origin.offset(axis.x * step, dy, axis.z * step);
          const block = bot.blockAt(position);
          if (!block) continue;
          if (UNSAFE_TUNNEL_BLOCKS.has(block.name)) score -= 50;
          else if (block.diggable === false) score -= 8;
          else if (block.name === 'air' || block.name === 'cave_air') score += 0.5;
          else score += 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    return best;
  }

  async placeTunnelTorch(bot, base) {
    const torch = this.findInventoryItem('torch');
    if (!torch) return false;
    const floor = bot.blockAt(base.offset(0, -1, 0));
    const spot = bot.blockAt(base);
    if (!floor || floor.boundingBox !== 'block' || !spot || spot.name !== 'air') return false;
    try {
      await this.equipItem('torch');
      await withTimeout(bot.placeBlock(floor, new Vec3(0, 1, 0)), 6000, 'Placing a torch');
      return true;
    } catch {
      return false;
    }
  }

  async stripMine(length = 16, { direction = null } = {}) {
    const bot = this.assertActive();
    const depth = Math.max(2, Math.min(Number(length) || 16, 64));
    if (!bestPickaxe(this.inventory())) {
      await this.ensureItem('wooden_pickaxe', 1, 0);
    }
    const axis = ['north', 'south', 'east', 'west'].includes(direction)
      ? direction
      : this.pickTunnelDirection(bot);
    const vector = {
      north: { x: 0, z: -1 },
      south: { x: 0, z: 1 },
      east: { x: 1, z: 0 },
      west: { x: -1, z: 0 }
    }[axis];
    const origin = bot.entity.position.floored();
    let mined = 0;
    let stoppedAt = null;
    for (let step = 1; step <= depth; step += 1) {
      const base = origin.offset(vector.x * step, 0, vector.z * step);
      for (const dy of [0, 1]) {
        this.assertActive();
        const position = base.offset(0, dy, 0);
        const block = bot.blockAt(position);
        if (!block || block.name === 'air' || block.name === 'cave_air') continue;
        if (UNSAFE_TUNNEL_BLOCKS.has(block.name)) {
          stoppedAt = block.name;
          break;
        }
        if (block.diggable === false) continue;
        try {
          await this.goto(new GoalNear(position.x, position.y, position.z, 1));
          const current = bot.blockAt(position);
          if (!current || current.name === 'air' || current.name === 'cave_air') continue;
          await withTimeout(bot.dig(current), 15000, 'Mining a block', () => bot.stopDigging?.());
          mined += 1;
        } catch (error) {
          if (error instanceof TaskAbortedError) throw error;
          throw new Error(`Tunnel blocked at ${position.x}, ${position.y}, ${position.z}: ${error.message}`);
        }
      }
      if (stoppedAt) break;
      if (step % 8 === 0) await this.placeTunnelTorch(bot, base);
    }
    if (mined === 0) {
      throw new Error(stoppedAt
        ? `I stopped the tunnel before hitting ${stoppedAt.replace(/_/g, ' ')}.`
        : 'The tunnel path was already open or blocked by unbreakable blocks.');
    }
    this.progress(`Tunneled ${mined} blocks ${axis}.`, { force: true });
    return {
      message: stoppedAt
        ? `Tunneled ${mined} blocks ${axis} and stopped before ${stoppedAt.replace(/_/g, ' ')}.`
        : `Tunneled ${mined} blocks ${axis}.`
    };
  }

  async fish(timeoutMs = 45000) {
    const bot = this.assertActive();
    if (!this.findInventoryItem('fishing_rod')) {
      await this.ensureItem('fishing_rod', 1, 0);
    }
    await this.equipItem('fishing_rod');
    const water = bot.findBlock({
      matching: block => block?.name === 'water' || block?.name === 'flowing_water',
      maxDistance: 16
    });
    if (!water) throw new Error('I need open water within 16 blocks to fish.');
    await this.goto(new GoalNear(water.position.x, water.position.y, water.position.z, 2));
    const fishNames = ['cod', 'salmon', 'tropical_fish', 'pufferfish'];
    const countFish = () => fishNames.reduce((sum, name) => sum + this.countItem(name), 0);
    const before = countFish();
    try {
      await withTimeout(
        bot.fish(),
        Math.max(15000, Math.min(Number(timeoutMs) || 45000, 90000)),
        'Fishing',
        () => bot.deactivateItem?.()
      );
    } catch (error) {
      if (error instanceof TaskAbortedError) throw error;
      throw new Error(`Fishing failed: ${error.message}`);
    }
    const after = countFish();
    return {
      message: after > before
        ? `Caught ${after - before} fish.`
        : 'Reeled in the line but nothing was caught.'
    };
  }

  async storeItem(name, count = 64) {
    const bot = this.assertActive();
    const normalized = canonicalItem(name);
    let chestBlock = bot.findBlock({
      matching: block => block.name === 'chest' || block.name === 'barrel' || block.name === 'trapped_chest',
      maxDistance: 16
    });
    if (!chestBlock) {
      await this.ensureItem('chest', 1);
      await this.equipItem('chest');
      const base = bot.entity.position.floored();
      for (let radius = 1; radius <= 2 && !chestBlock; radius += 1) {
        for (let dx = -radius; dx <= radius && !chestBlock; dx += 1) {
          for (let dz = -radius; dz <= radius && !chestBlock; dz += 1) {
            const support = bot.blockAt(base.offset(dx, -1, dz));
            const target = bot.blockAt(base.offset(dx, 0, dz));
            if (!support || support.boundingBox !== 'block' || !target || target.name !== 'air') continue;
            try {
              await withTimeout(bot.placeBlock(support, new Vec3(0, 1, 0)), 8000, 'Placing a block');
              await this.wait(250);
              chestBlock = bot.blockAt(support.position.offset(0, 1, 0));
            } catch {
              // Try another spot.
            }
          }
        }
      }
    }
    if (!chestBlock) throw new Error('I could not find or place a chest.');
    const item = this.findInventoryItem(normalized);
    if (!item) throw new Error(`I do not have any ${normalized.replace(/_/g, ' ')}.`);
    const chest = await withTimeout(bot.openChest(chestBlock), 8000, 'Opening the chest');
    try {
      await chest.deposit(item.type, null, Math.min(count, item.count));
      return { message: `Stored ${Math.min(count, item.count)} ${normalized.replace(/_/g, ' ')}.` };
    } finally {
      chest.close();
    }
  }

  async sortChests(category = 'all') {
    const bot = this.assertActive();
    const chestBlock = bot.findBlock({
      matching: block => block?.name === 'chest' || block?.name === 'barrel' || block?.name === 'trapped_chest',
      maxDistance: 16
    });
    if (!chestBlock) throw new Error('I could not find a chest or barrel within 16 blocks to organize.');

    const isToolOrWeapon = name => (
      name.endsWith('_pickaxe') || name.endsWith('_sword') || name.endsWith('_axe') ||
      name.endsWith('_shovel') || name.endsWith('_hoe') || name.endsWith('_helmet') ||
      name.endsWith('_chestplate') || name.endsWith('_leggings') || name.endsWith('_boots') ||
      name === 'shield' || name === 'totem_of_undying' || name === 'water_bucket' || name === 'compass'
    );

    const isFood = name => (
      ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'bread',
       'golden_apple', 'baked_potato', 'cooked_cod', 'cooked_salmon', 'apple'].includes(name)
    );

    const ORES = new Set([
      'coal', 'charcoal', 'raw_iron', 'raw_gold', 'raw_copper', 'iron_ingot', 'gold_ingot',
      'copper_ingot', 'diamond', 'emerald', 'redstone', 'lapis_lazuli', 'netherite_scrap',
      'netherite_ingot', 'quartz', 'amethyst_shard', 'iron_ore', 'deepslate_iron_ore',
      'gold_ore', 'deepslate_gold_ore', 'coal_ore', 'deepslate_coal_ore', 'diamond_ore',
      'deepslate_diamond_ore', 'copper_ore', 'deepslate_copper_ore'
    ]);

    const WOOD = new Set([
      'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
      'mangrove_log', 'cherry_log', 'oak_planks', 'birch_planks', 'spruce_planks',
      'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
      'stick', 'oak_door', 'oak_fence', 'oak_fence_gate', 'crafting_table'
    ]);

    const STONE = new Set([
      'cobblestone', 'stone', 'cobbled_deepslate', 'deepslate', 'granite', 'diorite',
      'andesite', 'tuff', 'calcite', 'gravel', 'sand', 'sandstone', 'dirt', 'grass_block'
    ]);

    const CROPS = new Set([
      'wheat', 'wheat_seeds', 'carrot', 'potato', 'beetroot', 'beetroot_seeds',
      'sugar_cane', 'pumpkin', 'melon', 'melon_slice', 'sweet_berries'
    ]);

    const DROPS = new Set([
      'rotten_flesh', 'bone', 'arrow', 'string', 'gunpowder', 'spider_eye',
      'slime_ball', 'ender_pearl', 'feather', 'leather', 'ink_sac'
    ]);

    const cat = String(category || 'all').toLowerCase();
    const shouldDeposit = (name, isPrimaryFood) => {
      if (isToolOrWeapon(name)) return false;
      if (isPrimaryFood) return false;
      if (cat === 'ores' || cat === 'ore') return ORES.has(name);
      if (cat === 'wood' || cat === 'logs') return WOOD.has(name);
      if (cat === 'stone' || cat === 'blocks') return STONE.has(name);
      if (cat === 'crops' || cat === 'farm') return CROPS.has(name);
      if (cat === 'drops' || cat === 'mob') return DROPS.has(name);
      return ORES.has(name) || WOOD.has(name) || STONE.has(name) || CROPS.has(name) || DROPS.has(name);
    };

    let reservedFoodSlot = null;
    const inv = bot.inventory?.items ? bot.inventory.items() : [];
    for (const item of inv) {
      if (isFood(item.name)) {
        reservedFoodSlot = item.slot;
        break;
      }
    }

    const itemsToDeposit = inv.filter(item => {
      const isPrimaryFood = item.slot === reservedFoodSlot;
      return shouldDeposit(item.name, isPrimaryFood);
    });

    if (itemsToDeposit.length === 0) {
      return { message: `No surplus ${cat === 'all' ? 'materials' : cat} found to store in the chest.` };
    }

    await this.goto(new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));
    const chest = await withTimeout(bot.openChest(chestBlock), 8000, 'Opening chest');
    let totalDeposited = 0;
    const depositedSummary = {};

    try {
      for (const item of itemsToDeposit) {
        this.assertActive();
        try {
          await chest.deposit(item.type, null, item.count);
          totalDeposited += item.count;
          depositedSummary[item.name] = (depositedSummary[item.name] || 0) + item.count;
          await this.wait(100);
        } catch (error) {
          if (error.message && error.message.includes('full')) break;
        }
      }
      if (typeof chest.items === 'function') {
        this.memory?.recordChest?.(chestBlock.position, chest.items());
      }
    } finally {
      chest.close();
    }

    const details = Object.entries(depositedSummary)
      .map(([name, count]) => `${count} ${name.replace(/_/g, ' ')}`)
      .slice(0, 5)
      .join(', ');

    return {
      message: totalDeposited > 0
        ? `Organized chest: deposited ${totalDeposited} item(s) (${details}).`
        : 'Could not deposit items; the chest might be full.',
      totalDeposited,
      items: depositedSummary
    };
  }

  async inspectStorage() {
    const bot = this.assertActive();
    const chests = bot.findBlocks({
      matching: block => block?.name === 'chest' || block?.name === 'barrel' || block?.name === 'trapped_chest',
      maxDistance: 24,
      count: 12
    });
    if (!chests.length) throw new Error('No chests or barrels found within 24 blocks.');
    let scanned = 0;
    const summary = {};
    for (const pos of chests) {
      this.assertActive();
      const block = bot.blockAt(pos);
      if (!block) continue;
      try {
        await this.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
        const chest = await withTimeout(bot.openChest(block), 8000, 'Opening storage');
        const items = typeof chest.items === 'function' ? chest.items() : [];
        this.memory?.recordChest?.(pos, items);
        for (const it of items) summary[it.name] = (summary[it.name] || 0) + it.count;
        chest.close();
        scanned += 1;
        await this.wait(150);
      } catch (e) {
        // Continue scanning others
      }
    }
    const sample = Object.entries(summary).slice(0, 5).map(([n, c]) => `${c} ${n.replace(/_/g, ' ')}`).join(', ');
    return {
      message: `Indexed ${scanned} storage container(s). Contents found: ${sample || 'empty'}.`,
      scanned,
      items: summary
    };
  }

  async locateItem(name) {
    this.assertActive();
    const canonical = canonicalItem(name);
    const inChests = this.memory?.findItemInChests?.(canonical) || [];
    const inInv = this.countItem(canonical);
    const lines = [];
    if (inInv > 0) lines.push(`In bot inventory: ${inInv} ${canonical.replace(/_/g, ' ')}`);
    if (inChests.length > 0) {
      for (const match of inChests) {
        const dist = this.bot?.entity?.position
          ? Math.round(this.bot.entity.position.distanceTo(new Vec3(match.chest.x, match.chest.y, match.chest.z)))
          : null;
        const distText = dist !== null ? ` (${dist} blocks away)` : '';
        lines.push(`${match.count}x in chest at ${match.chest.x}, ${match.chest.y}, ${match.chest.z}${distText}`);
      }
    }
    if (!lines.length) {
      return { message: `I could not find ${canonical.replace(/_/g, ' ')} in my inventory or known chests. Try !ai inspect storage to scan nearby chests.` };
    }
    return { message: `Storage location for ${canonical.replace(/_/g, ' ')}:\n` + lines.join('\n') };
  }

  async fetchFromStorage(name, count = 1) {
    const bot = this.assertActive();
    const canonical = canonicalItem(name);
    const amount = Math.max(1, Math.min(Number(count) || 1, 64));

    if (this.countItem(canonical) >= amount) {
      return this.deliverToPlayer(canonical, amount);
    }

    const matches = this.memory?.findItemInChests?.(canonical) || [];
    let chestTarget = null;
    if (matches.length > 0) {
      matches.sort((a, b) => {
        const dA = bot.entity.position.distanceTo(new Vec3(a.chest.x, a.chest.y, a.chest.z));
        const dB = bot.entity.position.distanceTo(new Vec3(b.chest.x, b.chest.y, b.chest.z));
        return dA - dB;
      });
      chestTarget = matches[0].chest;
    }

    if (!chestTarget) {
      const nearbyChests = bot.findBlocks({
        matching: b => b?.name === 'chest' || b?.name === 'barrel' || b?.name === 'trapped_chest',
        maxDistance: 24,
        count: 6
      });
      for (const pos of nearbyChests) {
        const blk = bot.blockAt(pos);
        if (!blk) continue;
        try {
          await this.goto(new GoalNear(pos.x, pos.y, pos.z, 2));
          const w = await withTimeout(bot.openChest(blk), 8000, 'Checking chest');
          const items = typeof w.items === 'function' ? w.items() : [];
          this.memory?.recordChest?.(pos, items);
          const hasItem = items.find(it => it.name === canonical);
          if (hasItem) {
            chestTarget = pos;
            await w.withdraw(hasItem.type, null, Math.min(amount, hasItem.count));
            w.close();
            break;
          }
          w.close();
        } catch {}
      }
    } else {
      const blk = bot.blockAt(new Vec3(chestTarget.x, chestTarget.y, chestTarget.z));
      if (blk) {
        await this.goto(new GoalNear(chestTarget.x, chestTarget.y, chestTarget.z, 2));
        const w = await withTimeout(bot.openChest(blk), 8000, 'Opening storage');
        const items = typeof w.items === 'function' ? w.items() : [];
        this.memory?.recordChest?.(chestTarget, items);
        const hasItem = items.find(it => it.name === canonical);
        if (hasItem) {
          await w.withdraw(hasItem.type, null, Math.min(amount, hasItem.count));
        }
        w.close();
      }
    }

    if (this.countItem(canonical) > 0) {
      return this.deliverToPlayer(canonical, Math.min(amount, this.countItem(canonical)));
    }
    throw new Error(`I could not find ${canonical.replace(/_/g, ' ')} in any accessible chest.`);
  }

  async buildStructure(type = 'tower') {
    const bot = this.assertActive();
    const kind = String(type || 'tower').toLowerCase();
    const origin = bot.entity.position.floored();

    const buildingBlocks = ['cobblestone', 'stone', 'oak_planks', 'birch_planks', 'dirt']
      .map(name => this.findInventoryItem(name))
      .find(Boolean);

    if (!buildingBlocks || this.countItem(buildingBlocks.name) < 16) {
      this.progress('Gathering stone/cobblestone for construction...', { force: true });
      try {
        await this.mine('stone', 24);
      } catch {
        // Build with available
      }
    }

    const mat = this.findInventoryItem('cobblestone') || this.findInventoryItem('stone') ||
      this.findInventoryItem('oak_planks') || this.findInventoryItem('dirt');
    if (!mat) throw new Error('I need building blocks (stone, cobblestone, planks, or dirt) to build.');

    const blockName = mat.name;
    const offsets = [];

    if (kind === 'tower' || kind === 'watchtower') {
      for (let y = 0; y <= 3; y++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (y < 3 && dx === 0 && dz === 0) continue;
            if (y === 3 && !(Math.abs(dx) === 1 && Math.abs(dz) === 1)) continue;
            offsets.push({ dx, dy: y, dz, block: blockName });
          }
        }
      }
      offsets.push({ dx: 0, dy: 3, dz: 0, block: 'torch' });
    } else if (kind === 'farm') {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dz === 0) continue;
          offsets.push({ dx, dy: -1, dz, block: 'dirt' });
        }
      }
      offsets.push({ dx: -2, dy: 0, dz: -2, block: 'torch' });
      offsets.push({ dx: 2, dy: 0, dz: 2, block: 'torch' });
    } else if (kind === 'wall') {
      for (let step = 0; step < 8; step++) {
        for (let y = 0; y < 3; y++) {
          offsets.push({ dx: step - 4, dy: y, dz: 2, block: blockName });
        }
        if (step === 0 || step === 7) {
          offsets.push({ dx: step - 4, dy: 3, dz: 2, block: 'torch' });
        }
      }
    } else {
      for (let y = 0; y <= 2; y++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            const isWall = Math.abs(dx) === 2 || Math.abs(dz) === 2;
            const isDoorway = y < 2 && dx === 0 && dz === -2;
            if (isWall && !isDoorway) {
              offsets.push({ dx, dy: y, dz, block: blockName });
            }
          }
        }
      }
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          offsets.push({ dx, dy: 3, dz, block: blockName });
        }
      }
      offsets.push({ dx: -1, dy: 1, dz: 0, block: 'torch' });
      offsets.push({ dx: 1, dy: 1, dz: 0, block: 'torch' });
    }

    this.progress(`Architect: Constructing ${kind} with ${offsets.length} elements...`, { force: true });
    let placedCount = 0;

    for (const item of offsets) {
      this.assertActive();
      const targetPos = origin.offset(item.dx, item.dy, item.dz);
      const existing = bot.blockAt(targetPos);
      if (existing && existing.name !== 'air' && existing.name !== 'cave_air' && existing.name !== 'water') continue;

      let ref = bot.blockAt(targetPos.offset(0, -1, 0));
      let face = new Vec3(0, 1, 0);
      if (!ref || ref.boundingBox !== 'block') {
        ref = bot.blockAt(targetPos.offset(1, 0, 0));
        face = new Vec3(-1, 0, 0);
      }
      if (!ref || ref.boundingBox !== 'block') continue;

      const blockToUse = (item.block === 'torch' && this.findInventoryItem('torch'))
        ? 'torch'
        : (this.findInventoryItem(item.block) ? item.block : blockName);

      try {
        await this.equipItem(blockToUse);
        await withTimeout(bot.placeBlock(ref, face), 6000, 'Placing structure block');
        await this.wait(60);
        placedCount++;
      } catch (e) {}
    }

    this.memory?.setFact?.(`structure:${kind}`, {
      kind,
      position: { x: origin.x, y: origin.y, z: origin.z },
      placedBlocks: placedCount,
      at: new Date().toISOString()
    });

    return {
      message: `Built ${kind} with ${placedCount} blocks at ${origin.x}, ${origin.y}, ${origin.z}.`,
      placedCount,
      kind
    };
  }

  async guardPlayer(targetPlayer = 'requester', durationMs = 120000) {
    const bot = this.assertActive();
    const playerName = targetPlayer === 'requester' ? (this.agent?.requestedBy || 'requester') : targetPlayer;
    this.progress(`Guard Mode: Active protection for ${playerName}.`, { force: true });
    const deadline = Date.now() + Math.max(10000, Math.min(Number(durationMs) || 120000, 600000));
    let threatsNeutralized = 0;

    while (Date.now() < deadline) {
      this.assertActive();
      const targetEntity = this.playerEntity(playerName);
      const playerPos = targetEntity?.position || bot.entity.position;

      const threat = Object.values(bot.entities || {}).find(e =>
        e && e.type === 'mob' && HOSTILE_MOBS.has(e.name) && e.position &&
        (e.position.distanceTo(playerPos) <= 12 || e.position.distanceTo(bot.entity.position) <= 10)
      );

      if (threat) {
        this.progress(`Intercepting ${threat.name} threatening ${playerName}!`, { force: true });
        try {
          await this.attackEntity(threat, { maxDistance: 16 });
          threatsNeutralized++;
        } catch (e) {
          if (e instanceof TaskAbortedError) throw e;
        }
      } else if (targetEntity && bot.entity.position.distanceTo(targetEntity.position) > 4) {
        try {
          await this.goto(new GoalNear(targetEntity.position.x, targetEntity.position.y, targetEntity.position.z, 2), { timeoutMs: 4000 });
        } catch {}
      }

      await this.wait(400);
    }

    return {
      message: `Guard mission completed for ${playerName}. Neutralized ${threatsNeutralized} hostile threat(s).`,
      threatsNeutralized
    };
  }
}

module.exports = {
  AISkills,
  MAX_ACTIONS_PER_TASK,
  TaskAbortedError
};
        const angle = Math.random() * Math.PI * 2;
        const distance = 6 + Math.random() * 12;
