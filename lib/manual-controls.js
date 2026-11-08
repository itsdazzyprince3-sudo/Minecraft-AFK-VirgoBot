'use strict';

const CONTROL_INPUTS = new Set([
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sneak',
  'sprint'
]);


// Blocks that open or toggle when right-clicked. Sneaking while clicking places a block against
// them instead, like the real game.
const INTERACTIVE_BLOCK = /(^|_)(chest|barrel|shulker_box|crafting_table|furnace|smoker|blast_furnace|anvil|enchanting_table|brewing_stand|grindstone|loom|stonecutter|cartography_table|smithing_table|lectern|beacon|hopper|dropper|dispenser|door|trapdoor|fence_gate|button|lever|bed|note_block|jukebox|cauldron|composter|bell|repeater|comparator|daylight_detector|crafter)$/;

// mineflayer's blockAtCursor() face index -> outward normal
const FACE_VECTORS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

function heldBlockName(bot) {
  const held = bot.heldItem;
  if (!held) return null;
  const blocks = bot.registry && bot.registry.blocksByName;
  return blocks && blocks[held.name] ? held.name : null;
}

function inventorySlot(bot, slot) {
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 0 || index > 45) throw new TypeError('Bad inventory slot.');
  return { index, item: bot.inventory && bot.inventory.slots ? bot.inventory.slots[index] : null };
}

async function performManualAction(bot, action, payload = {}) {
  if (!bot) throw new Error('The Minecraft bot is not connected.');
  switch (action) {
    case 'drop':
    case 'q': {
      const held = bot.heldItem;
      if (!held) return { action: 'drop', message: 'No item in hand to drop.' };
      const count = Number.isInteger(payload.count) && payload.count > 0 ? payload.count : 1;
      await bot.toss(held.type, null, Math.min(count, held.count));
      return { action: 'drop', item: held.name, count };
    }
    case 'attack':
    case 'swing': {
      const targetEntity = bot.entityAtCursor ? bot.entityAtCursor(3.5) : null;
      if (targetEntity) {
        bot.swingArm?.('right');
        bot.attack(targetEntity);
        return { action: 'attack', entity: targetEntity.name || targetEntity.username };
      }
      const block = bot.blockAtCursor && bot.dig ? bot.blockAtCursor(5) : null;
      if (block && block.name !== 'air' && block.name !== 'bedrock') {
        const digging = bot.targetDigBlock;
        if (digging && digging.position && digging.position.equals(block.position)) {
          return { action: 'dig', block: block.name, message: 'Already digging.' };
        }
        // Digging takes a while; do not hold the control channel for it. 'ignore' keeps the
        // bot looking where the player aims instead of snapping to the block centre.
        Promise.resolve(bot.dig(block, 'ignore')).catch(() => { /* aborted or out of reach */ });
        return { action: 'dig', block: block.name };
      }
      bot.swingArm?.('right');
      return { action: 'swing', message: 'Swung arm.' };
    }
    case 'attack_release': {
      if (bot.targetDigBlock) bot.stopDigging?.();
      return { action: 'attack_release' };
    }
    case 'use':
    case 'activate': {
      const targetBlock = bot.blockAtCursor ? bot.blockAtCursor(4.5) : null;
      if (targetBlock) {
        const sneaking = Boolean(bot.controlState && bot.controlState.sneak);
        const placeable = heldBlockName(bot);
        const opensOnClick = INTERACTIVE_BLOCK.test(targetBlock.name) && !(sneaking && placeable);
        const normal = FACE_VECTORS[targetBlock.face];
        if (placeable && !opensOnClick && normal && bot.placeBlock) {
          const { Vec3 } = require('vec3');
          await bot.placeBlock(targetBlock, new Vec3(normal[0], normal[1], normal[2]));
          return { action: 'place', block: placeable };
        }
        await bot.activateBlock(targetBlock);
        return { action: 'use', block: targetBlock.name };
      }
      if (!bot.usingHeldItem) bot.activateItem?.();
      return { action: 'use', message: 'Activated held item.' };
    }
    case 'use_release': {
      bot.deactivateItem?.();
      return { action: 'use_release' };
    }
    case 'swap_hand':
    case 'f': {
      const held = bot.heldItem;
      if (held) {
        await bot.equip?.(held, 'off-hand');
        return { action: 'swap_hand', equipped: held.name };
      }
      return { action: 'swap_hand', message: 'No item in hand to swap.' };
    }
    case 'slot': {
      const slot = Math.max(0, Math.min(8, Number(payload.slot ?? 0)));
      bot.setQuickBarSlot?.(slot);
      return { action: 'slot', slot };
    }
    case 'equip': {
      const { index, item } = inventorySlot(bot, payload.slot);
      if (!item) return { action: 'equip', message: 'That slot is empty.' };
      await bot.equip(item, 'hand');
      return { action: 'equip', item: item.name, slot: index };
    }
    case 'drop_slot': {
      const { index, item } = inventorySlot(bot, payload.slot);
      if (!item) return { action: 'drop_slot', message: 'That slot is empty.' };
      if (payload.all) await bot.tossStack(item);
      else await bot.toss(item.type, item.metadata ?? null, 1);
      return { action: 'drop_slot', item: item.name, slot: index, all: Boolean(payload.all) };
    }
    case 'pick': {
      const block = bot.blockAtCursor ? bot.blockAtCursor(5) : null;
      if (!block) return { action: 'pick', message: 'Not looking at a block.' };
      const item = bot.inventory.items().find(entry => entry.name === block.name);
      if (!item) return { action: 'pick', message: `You have no ${block.name}.` };
      await bot.equip(item, 'hand');
      return { action: 'pick', item: item.name };
    }
    case 'look':
    case 'aim': {
      const yaw = Number(payload.yaw ?? bot.entity?.yaw ?? 0);
      const pitch = Number(payload.pitch ?? bot.entity?.pitch ?? 0);
      if (bot.look) await bot.look(yaw, pitch, true);
      return { action: 'look', yaw, pitch };
    }
    case 'lookAt': {
      if (payload.x !== undefined && payload.y !== undefined && payload.z !== undefined) {
        const { Vec3 } = require('vec3');
        if (bot.lookAt) await bot.lookAt(new Vec3(Number(payload.x), Number(payload.y), Number(payload.z)), true);
        return { action: 'lookAt', target: [payload.x, payload.y, payload.z] };
      }
      return { action: 'lookAt', message: 'No coordinates provided.' };
    }
    default:
      throw new TypeError(`Unsupported manual action: ${action}`);
  }
}

function setManualControl(bot, activeControls, input, pressed) {
  if (!CONTROL_INPUTS.has(input)) {
    throw new TypeError('Unsupported movement control.');
  }
  if (typeof pressed !== 'boolean') {
    throw new TypeError('pressed must be a boolean.');
  }
  if (!bot || typeof bot.setControlState !== 'function') {
    throw new Error('Movement controls are unavailable for this bot.');
  }

  if (pressed && !activeControls.has(input)) {
    if (activeControls.size === 0) bot.pathfinder?.stop();
    bot.setControlState(input, true);
    activeControls.add(input);
  } else if (!pressed && activeControls.has(input)) {
    bot.setControlState(input, false);
    activeControls.delete(input);
  }

  return [...activeControls];
}

function releaseManualControls(bot, activeControls) {
  let firstError = null;
  if (bot && typeof bot.setControlState === 'function') {
    for (const input of activeControls) {
      try {
        bot.setControlState(input, false);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  }
  activeControls.clear();
  if (firstError) throw firstError;
}

class ManualControlSession {
  constructor({
    getBot,
    isConnected,
    leaseMs = 5000,
    onExpire = () => {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  }) {
    this.getBot = getBot;
    this.isConnected = isConnected;
    this.leaseMs = leaseMs;
    this.onExpire = onExpire;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.active = new Set();
    this.leaseTimer = null;
  }

  set(input, pressed) {
    const active = setManualControl(this.getBot(), this.active, input, pressed);
    this.refreshLease();
    return active;
  }

  heartbeat() {
    if (!this.active.size) return [];
    if (!this.isConnected()) {
      this.disconnect();
      throw new Error('The Minecraft bot is not connected.');
    }
    this.refreshLease();
    return [...this.active];
  }

  async performAction(action, payload) {
    if (!this.isConnected()) throw new Error('The Minecraft bot is not connected.');
    return performManualAction(this.getBot(), action, payload);
  }

  release() {
    this.clearLease();
    releaseManualControls(this.getBot(), this.active);
    return [];
  }

  disconnect() {
    this.clearLease();
    this.active.clear();
  }

  refreshLease() {
    this.clearLease();
    if (!this.active.size) return;

    this.leaseTimer = this.setTimeoutImpl(() => {
      this.leaseTimer = null;
      if (!this.active.size) return;
      try {
        this.release();
        this.onExpire();
      } catch (error) {
        this.active.clear();
        this.onExpire(error);
      }
    }, this.leaseMs);
    this.leaseTimer.unref?.();
  }

  clearLease() {
    if (this.leaseTimer) {
      this.clearTimeoutImpl(this.leaseTimer);
      this.leaseTimer = null;
    }
  }
}

module.exports = {
  CONTROL_INPUTS,
  ManualControlSession,
  performManualAction,
  setManualControl,
  releaseManualControls
};
