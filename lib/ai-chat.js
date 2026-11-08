'use strict';

const { MAX_MEMORY_NOTE_LENGTH } = require('./ai-memory');

// Command alias resolutions — expand shorthand into canonical forms
function normalizeCommandInput(input) {
  // "sygget me" -> "sygget" (the 'me' is just emphasis)
  const syggetMe = input.match(/^sygget\s+me\s*$/i);
  if (syggetMe) return { type: 'sygget', text: '' };
  if (/^sygget\s+me\s+(.+)$/i.test(input)) {
    return { type: 'sygget', text: RegExp.$1.trim() };
  }
  if (/^sygget$/i.test(input)) return { type: 'sygget', text: '' };
  if (/^sygget\s+/i.test(input)) return { type: 'sygget', text: input.replace(/^sygget\s+/i, '').trim() };

  // "ask", "do", "task" prefixes are already removed above; also support "chat", "talk", "say"
  let t = input.toLowerCase();
  if (/^(?:ask|do|task|chat|talk|say|command|cmd)\s+(.+)$/i.test(input)) {
    return { type: 'task', text: RegExp.$1 };
  }
  return input;
}

function parseAIChatCommand(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();

  // Support: !ai ..., /ai ..., !bot ..., virgo ..., @virgo ..., hey virgo ..., bot: ...
  const match = trimmed.match(/^(?:[!/]\s*(?:ai|bot)|(?:hey\s+)?virgo[,:]?|@virgo[,:]?|bot[,:]?)\s*([\s\S]*)$/i) ||
    trimmed.match(/^[!/]\s*ai(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  let input = (match[1] || '').trim();
  if (!input) return { type: 'help' };

  // Normalize shorthand (e.g. "sygget me" -> "sygget")
  const normalized = normalizeCommandInput(input);
  if (typeof normalized === 'object' && normalized?.type) {
    return normalized;
  }
  const lower = input.toLowerCase();

  // --- help system ---
  if (/^help$/i.test(lower) || /^commands$/i.test(lower)) return { type: 'help', text: '' };
  if (/^commands\s+(all|list)?$/i.test(lower)) return { type: 'help', text: 'all' };

  // --- status ---
  if (/^status$/i.test(lower)) return { type: 'status' };
  if (/^state$/i.test(lower)) return { type: 'status' };

  // --- stop ---
  if (/^stop$/i.test(lower)) return { type: 'stop' };
  if (/^exit$/i.test(lower)) return { type: 'stop' };

  // --- autonomous control ---
  if (/^pause(?: (?:pause|grind|stop|running|grinding))?/i.test(lower)) return { type: 'pause' };
  if (/^(?:resume|resume grind|resume grinding)$/i.test(lower)) return { type: 'resume' };

  // --- recovery ---
  if (/^recover$/i.test(lower)) return { type: 'recover' };

  // --- teach ---
  const teach = lower.match(/^teach\s+(.+)$/);
  if (teach) return { type: 'teach', text: teach[1].trim() };

  // --- plugins ---
  const pluginsCmd = lower.match(/^plugins(?:\s+([\s\S]+))?$/);
  if (pluginsCmd) return { type: 'plugins', text: (pluginsCmd[1] || '').trim() };

  // --- vision ---
  const visionCmd = lower.match(/^vision(?:\s+([\s\S]+))?$/);
  if (visionCmd) return { type: 'vision', text: (visionCmd[1] || '').trim() };

  // --- command sense: natural language intent routing ---
  // These are recognized BEFORE the generic task fallback so they route
  // directly to local/deterministic actions instead of the AI model.
  const intentPatterns = [
    // movement & navigation
    { pattern: /^(?:move|walk|go|travel|navigate)\s+(.+)$/i, type: 'task', text: (m) => m[1] },
    { pattern: /^(?:come|follow|here|to me|approach)$/i, type: 'task', text: () => 'come here' },
    { pattern: /^(?:stay|wait)$/i, type: 'task', text: () => 'stay here' },
    { pattern: /^(?:go to|return to|back to)\s+(.+)$/i, type: 'task', text: (m) => `goto ${m[1]}` },
    // combat & defense
    { pattern: /^(?:attack|fight|defend|defence|guard)\s+(.+)$/i, type: 'task', text: (m) => `attack ${m[1]}` },
    { pattern: /^(?:fight|attack|defend|defence)$/i, type: 'task', text: () => 'defend' },
    { pattern: /^(?:retreat|flight|run away)$/i, type: 'task', text: () => 'retreat' },
    // gathering & mining
    { pattern: /^(?:mine|dig|excavate|salvage|strip)\s+(.+)$/i, type: 'task', text: (m) => `mine ${m[1]}` },
    { pattern: /^(?:gather|gatherwood|wood|logs|timber|stone|ores|resources)$/i, type: 'task', text: () => 'gather resources' },
    { pattern: /^(?:fish|fishpole)$/i, type: 'task', text: () => 'fish' },
    { pattern: /^(?:farm|crops|agriculture)$/i, type: 'task', text: () => 'farm' },
    { pattern: /^(?:forage|explore|roam|scout)$/i, type: 'task', text: () => 'explore' },
    // crafting & building
    { pattern: /^(?:craft|crafting|make|build|construct|assemble)\s+(.+)$/i, type: 'task', text: (m) => `craft ${m[1]}` },
    { pattern: /^(?:build|construct|make)\s+(?:a )?(?:crafting table|workbench|furnace|chest|chest|bed|smoker|smoker)$/i, type: 'task', text: () => 'craft crafting_table' },
    { pattern: /^(?:craft|crafting|make|build|construct)\s+(.+)$/i, type: 'task', text: (m) => `craft ${m[1]}` },
    // inventory & items
    { pattern: /^(?:inventory|inv|items|stuff)$/i, type: 'task', text: () => 'inventory' },
    { pattern: /^(?:give me|hand me|get me|bring me)\s+(.+)$/i, type: 'task', text: (m) => `collect ${m[1]}` },
    { pattern: /^(?:drop|discard|throw away)\s+(.+)$/i, type: 'task', text: (m) => `drop ${m[1]}` },
    { pattern: /^(?:equip|wear|slot)\s+(.+)$/i, type: 'task', text: (m) => `equip ${m[1]}` },
    { pattern: /^(?:unequip|remove|slot)\s+(.+)$/i, type: 'task', text: (m) => `unequip ${m[1]}` },
    { pattern: /^(?:look at|inspect|examine|check)\s+(.+)$/i, type: 'task', text: (m) => `look at ${m[1]}` },
    // AI & knowledge
    { pattern: /^(?:ai|brain|think|reason|plan|think)$/i, type: 'task', text: () => 'think' },
    { pattern: /^(?:solve|plan|decompose|break down|strategy)\s+(.+)$/i, type: 'task', text: (m) => `solve ${m[1]}` },
    { pattern: /^(?:why|because|explain)$/i, type: 'task', text: () => 'why' },
    { pattern: /^(?:help|commands|commands list|list commands|what can you do|what do you know)$/i, type: 'help', text: () => 'all' },
    { pattern: /^(?:skills|skill catalog|skill list|skills list)$/i, type: 'task', text: () => 'skills' },
    { pattern: /^(?:research|learn|knowledge|know)$/i, type: 'task', text: () => 'research' },
    { pattern: /^(?:training|train|curriculum)$/i, type: 'task', text: () => 'train' },
    { pattern: /^(?:memory|memories|remembrances|remember)$/i, type: 'task', text: () => 'memory' },
    { pattern: /^(?:forget|unlearn|forget all)$/i, type: 'task', text: () => 'forgetAll' },
    { pattern: /^(?:model|settings|config|configuration)$/i, type: 'task', text: () => 'model' },
    // status & info
    { pattern: /^(?:status|state|health|hp|food|hunger|time|day|night|weather|players|nearby|stats|statistics)$/i, type: 'status' },
    { pattern: /^(?:where am i|where|location|position|coordinates|coords)$/i, type: 'task', text: () => 'where' },
    // utility
    { pattern: /^(?:stop|end|quit|exit|terminate|abort)$/i, type: 'stop' },
  ];;

  for (const rule of intentPatterns) {
    const match = lower.match(rule.pattern);
    if (match) {
      const textVal = typeof rule.text === 'function' ? rule.text(match) : rule.text;
      return { type: rule.type, text: textVal };
    }
  }

  // Fallback: generic task
  return { type: 'task', text: input };
}

function isAIChatAuthorized(username, allowedUsers) {
  if (typeof username !== 'string' || !Array.isArray(allowedUsers)) return false;
  const normalizedUsername = username.trim().toLowerCase();
  return normalizedUsername.length > 0 && (
    allowedUsers.includes('*') ||
    allowedUsers.some(user => typeof user === 'string' && user.trim().toLowerCase() === normalizedUsername)
  );
}

function shouldAutoRespondToChat(username, aiConfig) {
  if (aiConfig?.enabled !== true) return false;
  // If respondToChat or respondToTrustedChat is enabled, auto-respond to chat
  if (aiConfig.respondToChat === true || aiConfig.respondToTrustedChat === true) {
    return isAIChatAuthorized(username, aiConfig.allowedUsers);
  }
  return false;
}

function getAIChatAllowedUsers(aiConfig, chatConfig) {
  const configuredUsers = [
    ...(Array.isArray(aiConfig?.allowedUsers) ? aiConfig.allowedUsers : []),
    ...(Array.isArray(chatConfig?.tpWhitelist) ? chatConfig.tpWhitelist : [])
  ];
  return [...new Set(configuredUsers
    .filter(user => typeof user === 'string')
    .map(user => user.trim())
    .filter(Boolean)
    .map(user => user.toLowerCase()))];
}

function createTrustedChatMemoryNote(username, message, allowedUsers) {
  if (!isAIChatAuthorized(username, allowedUsers) || typeof message !== 'string') return null;
  const text = message.trim();
  if (!text) return null;
  return `${username}: ${text}`.slice(0, MAX_MEMORY_NOTE_LENGTH);
}

module.exports = {
  createTrustedChatMemoryNote,
  getAIChatAllowedUsers,
  isAIChatAuthorized,
  parseAIChatCommand,
  shouldAutoRespondToChat
};
