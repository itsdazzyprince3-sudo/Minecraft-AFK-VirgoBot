'use strict';

// Local, dependency-free planning helpers. These let Virgo act immediately
// without an API key, while the optional language model handles open-ended
// conversation and unusual requests.

const MAX_TASK_COUNT = 256;

const { parseMultilingualIntent } = require('./ai-nlp');

const LOG_NAMES = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'crimson_stem', 'warped_stem'
]);
const PLANK_NAMES = new Set([
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'pale_oak_planks', 'crimson_planks', 'warped_planks', 'bamboo_planks'
]);
const PLANKS_BY_LOG = {
  oak_log: 'oak_planks',
  birch_log: 'birch_planks',
  spruce_log: 'spruce_planks',
  jungle_log: 'jungle_planks',
  acacia_log: 'acacia_planks',
  dark_oak_log: 'dark_oak_planks',
  mangrove_log: 'mangrove_planks',
  cherry_log: 'cherry_planks',
  pale_oak_log: 'pale_oak_planks',
  crimson_stem: 'crimson_planks',
  warped_stem: 'warped_planks'
};
const FOOD_NAMES = new Set([
  'apple', 'baked_potato', 'beef', 'beetroot', 'beetroot_soup', 'bread',
  'carrot', 'chicken', 'cod', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
  'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon',
  'cookie', 'dried_kelp', 'golden_apple', 'golden_carrot', 'melon_slice',
  'mushroom_stew', 'mutton', 'porkchop', 'potato', 'pumpkin_pie', 'rabbit',
  'rabbit_stew', 'salmon', 'suspicious_stew', 'sweet_berries', 'tropical_fish',
  'honey_bottle', 'glistering_melon_slice', 'pufferfish', 'rotten_flesh',
  'spider_eye', 'poisonous_potato', 'chorus_fruit', 'kelp', 'dried_kelp_block'
]);
const COOKED_FOOD = new Set([
  'baked_potato', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
  'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit', 'cooked_salmon'
]);
const RAW_TO_COOKED = {
  beef: 'cooked_beef',
  chicken: 'cooked_chicken',
  cod: 'cooked_cod',
  mutton: 'cooked_mutton',
  porkchop: 'cooked_porkchop',
  rabbit: 'cooked_rabbit',
  salmon: 'cooked_salmon',
  potato: 'baked_potato'
};
const ANIMALS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'salmon', 'cod', 'tropical_fish']);
const HOSTILE_MOBS = new Set([
  'blaze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian', 'endermite',
  'evoker', 'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube', 'phantom',
  'piglin_brute', 'pillager', 'ravager', 'silverfish', 'skeleton', 'slime',
  'spider', 'stray', 'vex', 'vindicator', 'witch', 'wither_skeleton',
  'zoglin', 'zombie', 'zombie_villager'
]);

const BREED_FOODS = {
  cow: 'wheat',
  mooshroom: 'wheat',
  sheep: 'wheat',
  goat: 'wheat',
  pig: 'carrot',
  chicken: 'wheat_seeds',
  rabbit: 'carrot',
  horse: 'golden_apple',
  donkey: 'golden_apple',
  mule: 'golden_apple',
  wolf: 'beef',
  cat: 'cod',
  ocelot: 'cod',
  fox: 'sweet_berries',
  panda: 'bamboo',
  turtle: 'seagrass',
  bee: 'dandelion',
  llama: 'hay_block',
  trader_llama: 'hay_block',
  hoglin: 'crimson_fungus',
  strider: 'warped_fungus',
  axolotl: 'tropical_fish_bucket',
  camel: 'cactus',
  sniffer: 'torchflower_seeds',
  armadillo: 'spider_eye'
};

const ITEM_ALIASES = [
  ['oak logs', 'oak_log'], ['oak log', 'oak_log'], ['logs', 'oak_log'], ['log', 'oak_log'],
  ['wood', 'oak_log'], ['timber', 'oak_log'], ['trees', 'oak_log'], ['tree', 'oak_log'],
  ['planks', 'oak_planks'], ['plank', 'oak_planks'], ['wooden planks', 'oak_planks'],
  ['sticks', 'stick'], ['stick', 'stick'],
  ['cobblestone', 'cobblestone'], ['cobble', 'cobblestone'],
  ['stone', 'stone'], ['rocks', 'stone'], ['rock', 'stone'],
  ['coal ore', 'coal_ore'], ['coal', 'coal'],
  ['iron ore', 'iron_ore'], ['iron', 'iron_ingot'], ['iron ingot', 'iron_ingot'],
  ['raw iron', 'raw_iron'], ['gold ore', 'gold_ore'], ['gold', 'gold_ingot'],
  ['diamond ore', 'diamond_ore'], ['diamonds', 'diamond'], ['diamond', 'diamond'],
  ['copper ore', 'copper_ore'], ['copper', 'copper_ingot'],
  ['redstone ore', 'redstone_ore'], ['redstone', 'redstone'],
  ['emerald ore', 'emerald_ore'], ['emerald', 'emerald'],
  ['lapis ore', 'lapis_ore'], ['lapis', 'lapis_lazuli'],
  ['pickaxe', 'wooden_pickaxe'], ['pick axes', 'wooden_pickaxe'], ['pick axe', 'wooden_pickaxe'],
  ['sword', 'wooden_sword'], ['axe', 'wooden_axe'], ['shovel', 'wooden_shovel'],
  ['hoe', 'wooden_hoe'],
  ['crafting table', 'crafting_table'], ['workbench', 'crafting_table'],
  ['furnace', 'furnace'], ['chest', 'chest'], ['torch', 'torch'], ['torches', 'torch'],
  ['bed', 'bed'], ['shield', 'shield'], ['bucket', 'bucket'],
  ['bread', 'bread'], ['wheat', 'wheat'], ['seeds', 'wheat_seeds'], ['wheat seeds', 'wheat_seeds'],
  ['carrots', 'carrot'], ['carrot', 'carrot'], ['potatoes', 'potato'], ['potato', 'potato'],
  ['beef', 'beef'], ['steak', 'cooked_beef'], ['chicken', 'chicken'],
  ['pork', 'porkchop'], ['porkchop', 'porkchop'], ['mutton', 'mutton'],
  ['food', 'food'], ['meat', 'food'], ['animals', 'food'], ['animal', 'food'],
  ['dirt', 'dirt'], ['sand', 'sand'], ['gravel', 'gravel'],
  ['wool', 'white_wool'], ['string', 'string'], ['leather', 'leather'],
  ['book', 'book'], ['books', 'book'], ['boock', 'book'], ['bookshelf', 'bookshelf'],
  ['apple', 'apple'], ['apples', 'apple'],
  ['air', 'air']
];

for (const material of ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']) {
  for (const tool of ['pickaxe', 'sword', 'axe', 'shovel', 'hoe']) {
    ITEM_ALIASES.push([`${material} ${tool}`, `${material}_${tool}`]);
  }
}
ITEM_ALIASES.push(['golden apple', 'golden_apple'], ['golden carrot', 'golden_carrot']);

const SORTED_ITEM_ALIASES = [...ITEM_ALIASES].sort((left, right) => right[0].length - left[0].length);

const TOOL_TIER = {
  wooden_pickaxe: 1,
  stone_pickaxe: 2,
  copper_pickaxe: 2,
  iron_pickaxe: 3,
  golden_pickaxe: 1,
  diamond_pickaxe: 4,
  netherite_pickaxe: 5
};

const PICKAXE_BY_TIER = {
  1: 'wooden_pickaxe',
  2: 'stone_pickaxe',
  3: 'iron_pickaxe',
  4: 'diamond_pickaxe',
  5: 'netherite_pickaxe'
};

const RECIPE_GUIDE = {
  oak_planks: '1 log -> 4 planks (any log type works).',
  stick: '2 planks -> 4 sticks.',
  crafting_table: '4 planks -> 1 crafting table.',
  wooden_pickaxe: '3 planks + 2 sticks at a crafting table.',
  stone_pickaxe: '3 cobblestone + 2 sticks at a crafting table.',
  iron_pickaxe: '3 iron ingots + 2 sticks at a crafting table.',
  wooden_sword: '2 planks + 1 stick at a crafting table.',
  stone_sword: '2 cobblestone + 1 stick at a crafting table.',
  iron_sword: '2 iron ingots + 1 stick at a crafting table.',
  furnace: '8 cobblestone at a crafting table.',
  torch: '1 coal or charcoal + 1 stick -> 4 torches.',
  chest: '8 planks at a crafting table.',
  bed: '3 wool + 3 planks at a crafting table.',
  bread: '3 wheat at a crafting table.',
  bucket: '3 iron ingots at a crafting table.',
  shield: '6 planks + 1 iron ingot at a crafting table.'
};

const MC_FACTS = [
  [/what (?:is|are) (?:a )?(?:creeper|creepers)/i,
    'Creepers sneak up and explode. Keep 8+ blocks away, hit once, back off, and repeat. A shield blocks the blast.'],
  [/what (?:is|are) (?:a )?(?:zombie|zombies)/i,
    'Zombies burn in daylight and break doors on Hard. Fight them with a sword while backing up, or trap them behind two blocks.'],
  [/what (?:is|are) (?:a )?(?:enderman|endermen)/i,
    'Endermen teleport and hit hard. Do not look at their eyes. Wear a pumpkin if you must look, or fight them under a 2-block ceiling.'],
  [/what (?:is|are) (?:a )?(?:skeleton|skeletons)/i,
    'Skeletons shoot arrows. Close the distance while strafing, use a shield, or shoot back from cover.'],
  [/what (?:is|are) (?:a )?(?:witch|witches)/i,
    'Witches throw potions. Rush them with a sword; their healing cannot outrun steady damage.'],
  [/what (?:is|are) (?:a )?(?:warden|the warden|sculk)/i,
    'The Warden is summoned by Sculk Shriekers in the Deep Dark. It has 500 HP and tracks vibrations. Crouch-walk to stay undetected, distract with thrown projectiles, or flee!'],
  [/how (?:do|can) i (?:spawn|summon|fight|beat) (?:the )?wither|what is (?:the )?wither/i,
    'The Wither is spawned with 4 soul sand/soil in a T-shape with 3 wither skeleton skulls on top. Defeating it drops a Nether Star to craft Beacons.'],
  [/how (?:do|can) i (?:find|beat|kill|fight) (?:the )?ender dragon/i,
    'Reach the End via a Stronghold portal. Destroy the End Crystals on obsidian pillars first, then attack the dragon when it perches on the bedrock exit portal.'],
  [/how (?:do|can) i (?:find|activate) (?:the )?end portal/i,
    'Craft Eyes of Ender (ender pearl + blaze powder) and throw them to track the Stronghold. Place up to 12 eyes into the portal frame to open the dimension.'],
  [/how (?:do|can) i (?:make|build|light) (?:a )?nether portal/i,
    'Build a standing frame of obsidian at least 4 wide and 5 tall (minimum 10 obsidian blocks), then ignite the inside with flint and steel.'],
  [/how (?:do|can) i (?:find|get) (?:an? )?elytra/i,
    'Defeat the Ender Dragon, throw an ender pearl into the End gateway portal, locate an End City with an End Ship, and take the Elytra from the item frame.'],
  [/what (?:is|are) (?:a )?(?:shulker|shulker box)/i,
    'Shulkers live in End Cities and drop Shulker Shells. Combine 2 shells with a chest to craft a Shulker Box, which keeps its stored items when mined!'],
  [/how (?:do|can) i (?:find|get) ancient debris/i,
    'Ancient debris spawns in the Nether between Y=8 and Y=22 (most common at Y=15). Mine it with a diamond pickaxe or blast mine using beds.'],
  [/how (?:do|can) i (?:enchant|make an enchanting table)/i,
    'Craft an enchanting table with 4 obsidian, 2 diamonds, and 1 book. Surround it with 15 bookshelves leaving a 1-block gap for maximum level 30 enchantments.'],
  [/what (?:is|does) (?:the )?mending(?: enchantment)?(?: do)?/i,
    'Mending automatically repairs your equipped or held tools and armor using collected XP orbs. Get it by trading with a Librarian villager or from dungeon chests.'],
  [/what is the difference between fortune and silk touch|fortune vs silk touch/i,
    'Fortune multiplies mineral drops (diamonds, coal, redstone). Silk Touch drops the exact block (ice, glass, ores). They cannot be combined on the same tool.'],
  [/how (?:do|can) i (?:brew|make) potions/i,
    'Craft a brewing stand with 1 blaze rod and 3 cobblestone. Fuel it with blaze powder. Brew water bottles with nether wart to make Awkward Potions, then add effect ingredients.'],
  [/how (?:do|can) i (?:make|build) (?:an )?iron golem/i,
    'Place 4 iron blocks in a T-shape and place a carved pumpkin or jack-o-lantern on the top center block. Iron golems defend areas against hostiles.'],
  [/how (?:do|can) i (?:tame|breed) (?:a )?(?:wolf|dog)/i,
    'Feed bones to a wild wolf until hearts appear. Tamed wolves attack hostiles with you. Breed and heal them using any meat.'],
  [/how (?:do|can) i (?:tame|get) (?:a )?cat/i,
    'Sneak slowly while holding raw cod or salmon near stray cats in villages. Tamed cats scare away creepers and phantoms!'],
  [/how (?:do|can) i (?:tame|ride) (?:a )?horse/i,
    'Mount the horse with an empty hand repeatedly until hearts appear, then open its inventory and equip a saddle to steer.'],
  [/how (?:do|can) i (?:find|get) (?:iron|iron ore)/i,
    'Iron spawns from Y=72 down to Y=-64, most commonly around Y=16 and Y=-24. Dig a safe staircase, never straight down, and bring torches.'],
  [/how (?:do|can) i (?:find|get) (?:diamonds?|diamond ore)/i,
    'Diamonds are most common below Y=0, especially around Y=-58. Branch mine at that depth with a iron or better pickaxe and carry water.'],
  [/how (?:do|can) i (?:find|get) (?:coal|coal ore)/i,
    'Coal is common in exposed cliffs and caves from Y=256 down to Y=0. Mine it with any pickaxe.'],
  [/how (?:do|can) i (?:find|get) (?:gold|gold ore)/i,
    'Gold spawns below Y=32, most often around Y=-16 in the Badlands or Nether. Use an iron pickaxe or better.'],
  [/how (?:do|can) i (?:find|get) (?:food|eat)/i,
    'Hunt cows, pigs, chickens, sheep, or rabbits, then cook the meat in a furnace. You can also grow wheat, carrots, and potatoes.'],
  [/how (?:do|can) i (?:not )?die|survive/i,
    'Keep food above 6, carry a shield, light your base, never dig straight down, and retreat to a lit shelter at night.'],
  [/what (?:is|are) (?:the )?(?:best|strongest) (?:tool|pickaxe)/i,
    'Netherite is the strongest tier, then diamond, iron, stone, and wood. Enchant with Efficiency and Unbreaking for grinding.'],
  [/how (?:do|can) i (?:make|craft|get) (?:a )?(?:netherite|netherite ingot)/i,
    'Mine ancient debris in the Nether at Y=8-22, smelt it into netherite scrap, then combine 4 scrap + 4 gold ingots into a netherite ingot.'],
  [/how (?:do|can) i (?:make|craft|get) (?:a )?(?:beacon)/i,
    'A beacon needs 5 glass, 3 obsidian, and 1 nether star. The nether star drops from the Wither.'],
  [/how (?:do|can) i (?:make|craft|get) (?:a )?(?:shield)/i, RECIPE_GUIDE.shield],
  [/how (?:do|can) i (?:make|craft|get) (?:a )?(?:bed)/i, RECIPE_GUIDE.bed],
  [/how (?:do|can) i (?:make|craft|get) (?:a )?(?:furnace)/i, RECIPE_GUIDE.furnace],
  [/how (?:do|can) i (?:make|craft|get) (?:a )?(?:torch|torches)/i, RECIPE_GUIDE.torch]
];

const COUNT_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  stack: 64, stacks: 64, 'half stack': 32, dozen: 12
};

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9_\s:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeActionText(value) {
  let text = normalizeText(value);
  for (let pass = 0; pass < 4; pass += 1) {
    const cleaned = text
      .replace(/^(?:(?:hey\s+)?please\s+|(?:can|could|would|will)\s+you(?:\s+please)?\s+|would you mind\s+|(?:i need you to|i want you to|i would like you to|id like you to|help me(?: to)?)\s+|(?:go ahead and|just)\s+)/, '')
      .replace(/\s+(?:please|pls|for me|for us|if you can|if possible|when you can|right now|now|quickly|asap)$/, '')
      .trim();
    if (cleaned === text) break;
    text = cleaned;
  }
  return text;
}

function parseCount(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_TASK_COUNT, Math.floor(value)));
  }
  const text = normalizeText(value);
  const stackMatch = text.match(/(\d+)\s*stacks?/);
  if (stackMatch) return Math.max(1, Math.min(MAX_TASK_COUNT, Number(stackMatch[1]) * 64));
  const digitMatch = text.match(/\b(\d{1,4})\b/);
  if (digitMatch) return Math.max(1, Math.min(MAX_TASK_COUNT, Number(digitMatch[1])));
  for (const [word, count] of Object.entries(COUNT_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return count;
  }
  return fallback;
}

function stripCount(text) {
  return text
    .replace(/\b\d{1,4}\s*(?:x\s*)?/g, ' ')
    .replace(/\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|dozen|stack|stacks|half stack)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singularize(value) {
  const word = String(value || '').trim();
  if (word.endsWith('ies') && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ves') && word.length > 3) return `${word.slice(0, -3)}f`;
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 2) return word.slice(0, -1);
  return word;
}

function cleanItemPhrase(value) {
  let text = normalizeText(value)
    .replace(/^(?:some|any|the|my|your|me|us|please|pls|for me|for us)\s+/g, '')
    .replace(/\s+(?:please|pls|for me|for us|now|quickly|asap)$/g, '')
    .replace(/\b(?:blocks?|items?|pieces?|units?|ores?)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  for (const [alias, item] of SORTED_ITEM_ALIASES) {
    if (text === alias) return item;
  }
  for (const [alias, item] of SORTED_ITEM_ALIASES) {
    if (text.endsWith(` ${alias}`)) return item;
  }
  text = singularize(text).replace(/\s+/g, '_');
  return /^[a-z0-9_]+$/.test(text) ? text : '';
}

function extractItem(text) {
  const normalized = normalizeText(text);
  for (const [alias, item] of SORTED_ITEM_ALIASES) {
    if (new RegExp(`(?:^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(normalized)) {
      return item;
    }
  }
  return cleanItemPhrase(normalized
    .replace(/^(?:mine|get|gather|chop|dig|collect|craft|make|smelt|cook|give|bring|equip|use|find|need|want|deliver|toss|drop)\s+/i, '')
    .replace(/^(?:me|us)\s+/i, ''));
}

function canonicalMob(text) {
  const cleaned = normalizeText(text)
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/\s+/g, '_');
  if (!cleaned) return cleaned;
  const candidates = [cleaned];
  if (cleaned.endsWith('ies')) candidates.push(`${cleaned.slice(0, -3)}y`);
  if (cleaned.endsWith('es')) candidates.push(cleaned.slice(0, -2));
  if (cleaned.endsWith('s')) candidates.push(cleaned.slice(0, -1));
  for (const candidate of candidates) {
    if (HOSTILE_MOBS.has(candidate) || ANIMALS.has(candidate)) return candidate;
  }
  return cleaned;
}

function isLog(name) {
  return LOG_NAMES.has(name);
}

function isPlank(name) {
  return PLANK_NAMES.has(name);
}

function isFood(name) {
  return FOOD_NAMES.has(name);
}

function plankForLog(logName) {
  return PLANKS_BY_LOG[logName] || 'oak_planks';
}

function canonicalItem(name, fallback = '') {
  const cleaned = normalizeText(name).replace(/\s+/g, '_');
  if (!cleaned) return fallback;
  for (const [alias, item] of SORTED_ITEM_ALIASES) {
    if (cleaned === alias.replace(/\s+/g, '_')) return item;
  }

  // Preserve valid Minecraft IDs whose final letter is s; blindly singularizing
  // these turns real items such as cherry_planks into nonexistent cherry_plank.
  if (PLANK_NAMES.has(cleaned) || FOOD_NAMES.has(cleaned) ||
    ['shears', 'fireworks', 'wheat_seeds', 'pumpkin_seeds', 'melon_seeds'].includes(cleaned)) {
    return cleaned;
  }
  if (cleaned.endsWith('_plank') && PLANK_NAMES.has(`${cleaned}s`)) return `${cleaned}s`;

  const compoundPlurals = [
    ['_pickaxes', '_pickaxe'], ['_swords', '_sword'], ['_shovels', '_shovel'],
    ['_hoes', '_hoe'], ['_axes', '_axe'], ['_logs', '_log']
  ];
  for (const [plural, singular] of compoundPlurals) {
    if (cleaned.endsWith(plural)) return `${cleaned.slice(0, -plural.length)}${singular}`;
  }
  return cleaned.includes('_') ? cleaned : singularize(cleaned);
}

function parseLocalIntent(rawText) {
  const raw = typeof rawText === 'string' ? rawText.trim() : '';
  const text = normalizeActionText(raw);
  if (!text) {
    const polyglot = parseMultilingualIntent(raw);
    return polyglot || { type: 'help', raw };
  }

  if (/^(?:help|commands|what can you do|how do i use you)$/.test(text)) return { type: 'help', raw };
  if (/^(?:status|what are you doing|progress|are you done)\b/.test(text)) return { type: 'status', raw };
  if (/^(?:train(?:ing)? status|training state|are you training)$/.test(text)) {
    return { type: 'train', action: 'status', raw };
  }
  if (/^(?:stop|halt|end|pause)\s+(?:the\s+)?training$/.test(text)) {
    return { type: 'train', action: 'stop', raw };
  }
  const stopFullAuto = text.match(/^(?:stop ?full ?auto|stop ?full ?autonomy|stop ?autonomous ?mode)$/);
  if (stopFullAuto) return { type: 'fullauto', action: 'stop', raw };
  if (/^(?:stop|halt|cancel|abort|enough)\b/.test(text)) return { type: 'stop', raw };
  if (/^(?:pause|wait|hold on|stand by)\b/.test(text)) return { type: 'pause', raw };
  if (/^(?:resume|continue|keep going|carry on)\b/.test(text)) return { type: 'resume', raw };

  const polyglot = parseMultilingualIntent(raw);
  if (polyglot) return polyglot;

  if (/^(?:recognize|recognise|survey|scan|scan surroundings|what do you see|look around and recognize)$/.test(text)) {
    return { type: 'recognize', raw };
  }

  const fullAuto = text.match(/^(?:full ?auto|full ?autonomy|autonomous ?mode|auto ?everything|do ?everything)$/);
  if (fullAuto) return { type: 'fullauto', action: 'start', raw };
  const trainModel = text.match(/^(?:train\s+(?:the\s+)?(?:neural\s+)?model|model\s+train)(?:\s+(\d+))?(?:\s*(?:epochs|rounds|steps))?$/);
  if (trainModel) {
    const epochs = parseCount(trainModel[1], 10);
    return { type: 'model', action: 'train', epochs, raw };
  }
  if (/^(?:model\s+status|neural\s+status|model\s+info|ai\s+model|show\s+(?:the\s+)?model)$/.test(text)) {
    return { type: 'model', action: 'status', raw };
  }
  if (/^(?:model\s+eval|model\s+evaluate|model\s+predict|evaluate\s+model|test\s+model)$/.test(text)) {
    return { type: 'model', action: 'eval', raw };
  }

  const trainTopic = text.match(/^train (?:yourself )?(?!on\b|forever\b|\d)([a-z][a-z\s-]{2,})$/);
  if (trainTopic) return { type: 'research', topic: trainTopic[1].trim(), raw };
  const research = text.match(/^(?:research|study|investigate|learn about|find out about|train (?:yourself )?on)\s+(.+)$/);
  if (research) return { type: 'research', topic: research[1].trim(), raw };

  const knowledge = text.match(/^(?:knowledge|known facts|what do you know(?: about)?|tell me about)\s*(.*)$/);
  if (knowledge) return { type: 'knowledge', query: knowledge[1].trim(), raw };

  const trainDuration = text.match(/^(?:train|study|practice)(?:\s+yourself)?\s+(?:for\s+)?(\d+)\s*(hours?|hrs?|h|minutes?|mins?)\b\s*(?:more|straight)?$/);
  if (trainDuration) {
    const amount = parseCount(trainDuration[1], 1);
    const durationMs = trainDuration[2].toLowerCase().startsWith('h') ? amount * 3600000 : amount * 60000;
    return { type: 'train', action: 'start', durationMs, raw };
  }
  const trainCount = text.match(/^(?:train|study|practice)(?:\s+yourself)?\s+(?:for\s+)?(\d+)\s*(?:cycles|topics|rounds|times)?$/);
  if (trainCount) return { type: 'train', action: 'start', iterations: parseCount(trainCount[1], 1), raw };
  if (/^(?:train(?: yourself)?|start training|self[- ]?train|keep training|learn on your own|study on your own|train forever)$/.test(text)) {
    return { type: 'train', action: 'start', iterations: null, raw };
  }

  const teach = text.match(/^(?:teach|learn|remember|note)\s+(.+)$/);
  if (teach) return { type: 'teach', text: teach[1].trim(), raw };
  if (/^(?:memory|memories|what have you learned|show memory)$/.test(text)) return { type: 'memory', raw };
  if (/^(?:forget|clear|erase)\s+(?:all|everything|all memory|memory)$/.test(text)) return { type: 'forgetAll', raw };
  const forget = text.match(/^(?:forget|delete note)\s+(.+)$/);
  if (forget) return { type: 'forget', text: forget[1].trim(), raw };

  const skillList = text.match(/^skills?\s*(.*)$/);
  if (skillList) {
    const rest = skillList[1].trim();
    if (!rest) return { type: 'skills', query: null, raw };
    const run = rest.match(/^(?:run\s+|do\s+|use\s+)?([a-z]+:[a-z0-9_]+)(?:\s+(\d+))?$/);
    if (run) return { type: 'skill', id: run[1], count: parseCount(run[2]), raw };
    return { type: 'skills', query: rest, raw };
  }

  if (/^(?:think|reason)$/.test(text)) return { type: 'brain', raw };
  const think = text.match(/^(?:think|reason|work out|figure out|plan out|plan how to|deliberate on)\s+(.+)$/);
  if (think) return { type: 'think', goal: think[1].trim(), raw };
  const solve = text.match(/^(?:solve|achieve|accomplish|carry out|execute plan for)\s+(.+)$/);
  if (solve) return { type: 'solve', goal: solve[1].trim(), raw };

  const coordsMatch = text.match(/^(?:come(?:\s+to)?|go(?:\s+to)?|walk(?:\s+to)?|navigate(?:\s+to)?|tp(?:\s+to)?)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/) ||
    text.match(/^(?:goto|coords?)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/) ||
    text.match(/^(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
  if (coordsMatch) {
    return {
      type: 'gotoCoords',
      x: parseInt(coordsMatch[1], 10),
      y: parseInt(coordsMatch[2], 10),
      z: parseInt(coordsMatch[3], 10),
      raw
    };
  }

  const movement = text.match(/^(?:come|go|walk|move|step|head|run|travel|navigate|get)\s+(?:(?:right\s+)?(?:over|up|closer|back)\s+)?(?:to|towards?|near)\s+(?:player\s+)?(me|us|requester|my location|my position|where i am|[a-z0-9_]{2,16})\b/);
  if (movement) {
    const target = movement[1];
    return { type: 'come', player: ['me', 'us', 'requester', 'my location', 'my position', 'where i am'].includes(target) ? 'requester' : target, raw };
  }
  if (/^(?:come|come(?:\s+(?:over|right over))?\s+here|tp to me|teleport to me|come here|come to me)\b/.test(text)) {
    return { type: 'come', player: 'requester', raw };
  }
  if (/^(?:follow|follow me|stay with me|escort me)\b/.test(text)) {
    const target = text.match(/(?:follow|escort)\s+([a-z0-9_]{2,16})/);
    return {
      type: 'follow',
      player: target && !['me', 'us'].includes(target[1]) ? target[1] : 'requester',
      durationMs: 120000,
      raw
    };
  }
  if (/^(?:stay(?:\s+here)?|wait here|hold position|guard(?:\s+here)?)$/.test(text)) {
    return { type: 'stay', raw };
  }

  if (/^(?:inventory|inv|what do you have|what is in your inventory|items)\b/.test(text)) {
    return { type: 'inventory', raw };
  }
  if (/^(?:where are you|coords|coordinates|position|where)\b/.test(text)) {
    return { type: 'where', raw };
  }
  if (/^(?:health|hp|how much health|are you hurt)\b/.test(text)) {
    return { type: 'health', raw };
  }
  if (/^(?:food|hunger|are you hungry)\b/.test(text)) {
    return { type: 'food', raw };
  }
  if (/^(?:time|what time is it|is it day|is it night)\b/.test(text)) {
    return { type: 'time', raw };
  }
  if (/^(?:players|who is online|who is here)\b/.test(text)) {
    return { type: 'players', raw };
  }
  if (/^(?:difficulty|server difficulty|what difficulty|how hard is the server|what is the difficulty)\b/.test(text)) {
    return { type: 'difficulty', raw };
  }
  if (/^(?:nearby|what is nearby|surroundings|see)\b/.test(text)) {
    return { type: 'nearby', raw };
  }
  if (/^(?:stats|skills|what have you learned|memory)\b/.test(text)) {
    return { type: 'stats', raw };
  }

  const recipe = raw.match(/(?:how (?:do|can) i (?:make|craft|get)|what (?:do i need|are the ingredients) (?:for|to make))\s+(?:a|an|the)?\s*(.+)$/i);
  if (recipe) {
    return { type: 'recipe', item: extractItem(recipe[1]) || cleanItemPhrase(recipe[1]), raw };
  }

  const grind = text.match(/^(?:grind|auto|automatic|keep grinding|start grinding|go grind|work|help me grind)(?:\s+(.+))?$/);
  if (grind) {
    const goalText = (grind[1] || '').trim();
    let goal = 'auto';
    let item = null;
    if (/wood|log|tree|timber/.test(goalText)) goal = 'wood';
    else if (/stone|cobble|rock/.test(goalText)) goal = 'stone';
    else if (/coal/.test(goalText)) goal = 'coal';
    else if (/iron/.test(goalText)) goal = 'iron';
    else if (/diamond/.test(goalText)) goal = 'diamond';
    else if (/food|eat|hunt|meat/.test(goalText)) goal = 'food';
    else if (/farm|crop|wheat/.test(goalText)) goal = 'farm';
    else if (/build|shelter|house|base/.test(goalText)) goal = 'build';
    else if (goalText) item = extractItem(goalText) || cleanItemPhrase(goalText);
    return { type: 'grind', goal, item, raw };
  }

  if (/^(?:what should i do|what next|what now|plan|suggest|advice|help me)\b/.test(text)) {
    return { type: 'plan', raw };
  }

  if (/^(?:brain|cognition|mind|cot|chain of thought|show (?:me )?your (?:brain|thoughts)|what are you thinking|how do you think)$/.test(text)) {
    return { type: 'brain', raw };
  }
  if (/^(?:why|why did you(?: (?:do|choose))?(?: that| this)?|explain your reasoning|what was your reasoning)$/.test(text)) {
    return { type: 'why', raw };
  }

  if (/^(?:eat|feed yourself|have a snack)\b/.test(text)) return { type: 'eat', raw };
  if (/^(?:sleep|go to bed|rest)\b/.test(text)) return { type: 'sleep', raw };
  if (/^(?:farm|crops|harvest|plant)\b/.test(text)) return { type: 'farm', raw };
  if (/^(?:build|shelter|house|base|fort)\b/.test(text) &&
      !/^(?:build|construct|erect)\s+(?:a |the )?(?:tower|watchtower|farm|house|cabin|wall|bunker|base)$/.test(text)) {
    return { type: 'build', raw };
  }
  if (/^(?:defend|protect me|kill (?:the )?(?:mob|zombie|skeleton|creeper))\b/.test(text)) {
    return { type: 'defend', raw };
  }
  if (/^(?:explore|scout|look around|roam)\b/.test(text)) {
    return { type: 'explore', radius: parseCount(text.match(/radius\s+(\d+)/)?.[1], 24), raw };
  }

  if (/^(?:drop|toss|throw|q)$/.test(text) || /^(?:drop|toss)\s+(?:item|held\s+item|it|hand)$/.test(text)) {
    return { type: 'drop', item: null, count: 1, raw };
  }
  const dropExplicit = text.match(/^(?:drop|toss|throw)\s+(?:(\d+)\s+)?(.+)$/);
  if (dropExplicit && !/^(?:me|us)$/.test(dropExplicit[2])) {
    const item = extractItem(dropExplicit[2]);
    if (item) return { type: 'drop', item, count: parseCount(dropExplicit[1], 1), raw };
  }
  const lookMatch = text.match(/^(?:look|aim|face)(?:\s+at)?\s+(.+)$/);
  if (lookMatch) {
    return { type: 'look', target: lookMatch[1].trim(), raw };
  }
  if (/^(?:look\s+around|aim|look)$/.test(text)) {
    return { type: 'look', target: 'around', raw };
  }
  const slotMatch = text.match(/^(?:slot|hotbar|select\s+slot)\s*(\d)$/);
  if (slotMatch) {
    return { type: 'slot', slot: Number(slotMatch[1]), raw };
  }
  if (/^(?:swing|punch|hit|left\s+click|attack\s+air)$/.test(text)) {
    return { type: 'swing', raw };
  }
  if (/^(?:use|right\s+click|activate|interact)$/.test(text)) {
    return { type: 'use', raw };
  }

  const give = text.match(/^(?:give|bring|deliver|hand|toss|drop)\s+(?:me|us)?\s*(?:(\d+)\s+)?(.+)$/);
  if (give) {
    const item = extractItem(give[2]);
    if (item) {
      return {
        type: 'deliver',
        item,
        count: parseCount(give[1], 8),
        player: 'requester',
        raw
      };
    }
  }

  const tunnel = text.match(/^(?:tunnel|strip mine|strip-mine|branch mine|dig (?:a |the )?tunnel|mine (?:a |the )?tunnel)\s*(?:(\d+))?$/);
  if (tunnel) return { type: 'stripMine', length: parseCount(tunnel[1], 16), raw };

  if (/^(?:fish|go fishing|catch (?:a )?fish|do some fishing)$/.test(text)) return { type: 'fish', raw };

  const sort = text.match(/^(?:sort|organize|deposit|tidy|store all|deposit all|pack away)(?:\s+(?:the\s+)?(?:chests?|items?|inventory))?(?:\s+(ores?|wood|logs?|stones?|blocks?|crops?|farm|drops?|all))?$/);
  if (sort) {
    return { type: 'sortChests', category: sort[1] || 'all', raw };
  }
  const storeCat = text.match(/^(?:store|deposit|put away|dump)\s+(ores?|wood|logs?|stones?|blocks?|crops?|farm|drops?|all)$/);
  if (storeCat) {
    return { type: 'sortChests', category: storeCat[1], raw };
  }

  const withdraw = text.match(/^(?:withdraw|unstore|retrieve)\s+(?:(\d+)\s+)?(.+)$/) ||
    text.match(/^(?:take|pull|grab)\s+(?:(\d+)\s+)?(.+?)\s+(?:from|out of)\s+(?:the\s+)?(?:chest|storage)$/);
  if (withdraw) {
    const item = extractItem(withdraw[2]) || cleanItemPhrase(withdraw[2]);
    return { type: 'withdrawItem', item, count: parseCount(withdraw[1], 64), raw };
  }

  const locate = text.match(/^(?:locate|where is|find|search for)\s+(.+?)(?:\s+in\s+storage|\s+in\s+chests?)?$/);
  if (locate) {
    const item = extractItem(locate[1]) || cleanItemPhrase(locate[1]);
    if (item && !['me', 'us', 'you', 'here', 'home'].includes(item)) {
      return { type: 'locate', item, raw };
    }
  }

  const fetchStorage = text.match(/^(?:fetch|grab from storage|bring from storage|pull from storage|get from storage)\s+(?:(\d+)\s+)?(.+)$/);
  if (fetchStorage) {
    const item = extractItem(fetchStorage[2]) || cleanItemPhrase(fetchStorage[2]);
    return { type: 'fetch', item, count: parseCount(fetchStorage[1], 1), raw };
  }

  if (/^(?:scan storage|inspect storage|index storage|inspect chests|scan chests|index base|storage)$/.test(text)) {
    return { type: 'inspectStorage', raw };
  }

  const buildStruct = text.match(/^(?:build|construct|erect)\s+(?:a |the )?(tower|watchtower|farm|house|cabin|wall|bunker|base)$/);
  if (buildStruct) {
    return { type: 'buildStructure', structure: buildStruct[1], raw };
  }

  const guardMatch = text.match(/^(?:guard|bodyguard|protect|watch over)\s*(.*)$/);
  if (guardMatch && !/^(?:the )?(?:mob|zombie|skeleton|creeper|spider)/.test(guardMatch[1])) {
    const target = guardMatch[1].trim() || 'requester';
    return { type: 'guard', player: target, raw };
  }

  const mine = text.match(/^(?:mine|dig|break|chop|cut|gather|collect|get|find|harvest|grind for)\s+(?:(\d+)\s+)?(.+)$/);
  if (mine) {
    const phrase = mine[2];
    const item = extractItem(phrase);
    if (item) {
      const count = parseCount(mine[1], /log|wood|timber/.test(phrase) ? 16 : 8);
      if (isLog(item) || /wood|log|timber|tree/.test(phrase)) {
        return { type: 'gather', goal: 'wood', item: item || 'oak_log', count, raw };
      }
      if (/food|meat|animal|hunt/.test(phrase)) {
        return { type: 'gather', goal: 'food', item: 'food', count, raw };
      }
      if (/stone|cobble|rock/.test(item)) {
        return { type: 'mine', item: 'stone', count, raw };
      }
      return { type: 'mine', item, count, raw };
    }
  }

  if (/\b(?:armor|armour)\b/.test(text) &&
    /\b(?:set|full|make|craft|get|need|want|equip|wear|prepare)\b/.test(text)) {
    return { type: 'solve', goal: text, raw };
  }
  if (/\btools?\b/.test(text) && !/\b(?:pickaxe|sword|axe|shovel|hoe)\b/.test(text) &&
    /\b(?:set|full|make|craft|get|need|want|equip|prepare)\b/.test(text)) {
    return { type: 'solve', goal: text, raw };
  }

  const craft = text.match(/^(?:craft|make|build|create)\s+(?:(\d+)\s+)?(.+)$/);
  if (craft) {
    const item = extractItem(craft[2]);
    if (item) {
      return { type: 'craft', item, count: parseCount(craft[1], 1), raw };
    }
  }

  const smelt = text.match(/^(?:smelt|cook|furnace)\s+(?:(\d+)\s+)?(.+)$/);
  if (smelt) {
    const item = extractItem(smelt[2]);
    if (item) return { type: 'smelt', item, count: parseCount(smelt[1], 8), raw };
  }

  const equip = text.match(/^(?:equip|wear|hold|use)\s+(.+)$/);
  if (equip) {
    const item = extractItem(equip[1]);
    if (item) return { type: 'equip', item, raw };
  }

  const attack = text.match(/^(?:attack|kill|fight|slay)\s+(.+)$/);
  if (attack) {
    const target = canonicalMob(attack[1]);
    return { type: 'attack', target, raw };
  }

  const hunt = text.match(/^(?:hunt|track|chase)\s+(?:(\d+)\s+)?(.+)$/);
  if (hunt) {
    const target = canonicalMob(hunt[2]);
    return { type: 'hunt', target, count: parseCount(hunt[1], 1), raw };
  }

  const breed = text.match(/^(?:breed|mate|raise|feed)\s+(?:(\d+)\s+)?(.+)$/);
  if (breed && !/^(?:yourself|me|us)$/.test(breed[2])) {
    const target = canonicalMob(breed[2]);
    return { type: 'breed', target, count: parseCount(breed[1], 2), raw };
  }

  const learnFact = text.match(/^(?:that|this is|my|i like|i prefer|i hate|dont|don't)\s+(.+)$/);
  if (learnFact) return { type: 'teach', text: raw, raw };

  if (/^(?:hi|hello|hey|yo|sup|hiya|good morning|good evening|how are you)\b/.test(text)) {
    return { type: 'chat', intent: 'greeting', raw };
  }
  if (/^(?:thanks|thank you|ty|nice|good job|well done|great|awesome)\b/.test(text)) {
    return { type: 'chat', intent: 'thanks', raw };
  }
  if (/^(?:yes|yeah|yep|ok|okay|sure|cool)\b/.test(text)) {
    return { type: 'chat', intent: 'acknowledge', raw };
  }
  if (/^(?:no|nope|dont|stop it)\b/.test(text)) return { type: 'stop', raw };

  if (/^(?:can|could|would|will) you\s+(.+)$/.test(text)) {
    const inner = raw.replace(/^(?:can|could|would|will)\s+you\s+/i, '');
    const parsed = parseLocalIntent(inner);
    if (parsed.type !== 'chat') return parsed;
  }

  return { type: 'chat', intent: 'question', raw };
}

function planForIntent(intent) {
  switch (intent.type) {
    case 'come':
      return [{ skill: 'comeToPlayer', args: { player: intent.player || 'requester' } }];
    case 'gotoCoords':
      return [{ skill: 'gotoCoordinates', args: { x: intent.x, y: intent.y, z: intent.z } }];
    case 'follow':
      return [{ skill: 'followPlayer', args: { player: intent.player || 'requester', durationMs: intent.durationMs } }];
    case 'mine':
      return [{ skill: 'mine', args: { item: intent.item, count: intent.count } }];
    case 'gather':
      if (intent.goal === 'wood') return [{ skill: 'gatherWood', args: { count: intent.count } }];
      if (intent.goal === 'food') return [{ skill: 'gatherFood', args: { count: intent.count } }];
      return [{ skill: 'gather', args: { goal: intent.goal, count: intent.count } }];
    case 'craft':
      return [{ skill: 'ensureItem', args: { item: intent.item, count: intent.count } }];
    case 'smelt':
      return [{ skill: 'smelt', args: { item: intent.item, count: intent.count } }];
    case 'deliver':
      return [{ skill: 'deliverToPlayer', args: { item: intent.item, count: intent.count, player: intent.player || 'requester' } }];
    case 'eat':
      return [{ skill: 'eat', args: {} }];
    case 'sleep':
      return [{ skill: 'sleep', args: {} }];
    case 'farm':
      return [{ skill: 'farm', args: {} }];
    case 'build':
      return [{ skill: 'buildShelter', args: {} }];
    case 'stripMine': return [{ skill: 'stripMine', args: { length: intent.length } }];
    case 'fish': return [{ skill: 'fish', args: {} }];
    case 'withdrawItem': return [{ skill: 'withdrawItem', args: { item: intent.item, count: intent.count } }];
    case 'locate': return [{ skill: 'locateItem', args: { item: intent.item } }];
    case 'fetch': return [{ skill: 'fetchFromStorage', args: { item: intent.item, count: intent.count } }];
    case 'inspectStorage': return [{ skill: 'inspectStorage', args: {} }];
    case 'buildStructure': return [{ skill: 'buildStructure', args: { structure: intent.structure } }];
    case 'guard': return [{ skill: 'guardPlayer', args: { player: intent.player } }];
    case 'sortChests': return [{ skill: 'sortChests', args: { category: intent.category || 'all' } }];
    case 'hunt': return [{ skill: 'huntMob', args: { target: intent.target, count: intent.count } }];
    case 'breed': return [{ skill: 'breedAnimal', args: { target: intent.target, count: intent.count } }];
    case 'attack':
      return [{ skill: 'attackNearest', args: { target: intent.target } }];
    case 'defend':
      return [{ skill: 'defend', args: {} }];
    case 'explore':
      return [{ skill: 'explore', args: { radius: intent.radius } }];
    case 'equip':
      return [{ skill: 'equipItem', args: { item: intent.item } }];
    case 'stay':
      return [{ skill: 'stay', args: {} }];
    default:
      return [];
  }
}

function describeIntent(intent) {
  switch (intent.type) {
    case 'come': return 'come to you';
    case 'gotoCoords': return `navigate to ${intent.x}, ${intent.y}, ${intent.z}`;
    case 'follow': return 'follow you';
    case 'mine': return `mine ${intent.count} ${intent.item.replace(/_/g, ' ')}`;
    case 'gather': return `gather ${intent.count} ${intent.goal}`;
    case 'craft': return `craft ${intent.count} ${intent.item.replace(/_/g, ' ')}`;
    case 'smelt': return `smelt ${intent.count} ${intent.item.replace(/_/g, ' ')}`;
    case 'deliver': return `bring you ${intent.count} ${intent.item.replace(/_/g, ' ')}`;
    case 'eat': return 'eat something';
    case 'sleep': return 'find a bed';
    case 'farm': return 'work the farm';
    case 'build': return 'build a shelter';
    case 'attack': return `fight ${intent.target}`;
    case 'defend': return 'defend the area';
    case 'explore': return 'scout the area';
    case 'grind': return intent.goal && intent.goal !== 'auto' ? `grind ${intent.goal}` : 'grind resources';
    case 'equip': return `equip ${intent.item.replace(/_/g, ' ')}`;
    case 'stay': return 'hold position';
    case 'difficulty': return 'report the server difficulty';
    case 'brain': return 'inspect its own reasoning';
    case 'why': return 'explain the last decision';
    case 'stripMine': return `tunnel ${intent.length} blocks`;
    case 'fish': return 'fish';
    case 'withdrawItem': return `withdraw ${intent.count} ${intent.item}`;
    case 'locate': return `locate ${intent.item}`;
    case 'fetch': return `fetch ${intent.count} ${intent.item} from storage`;
    case 'inspectStorage': return 'index storage';
    case 'buildStructure': return `build ${intent.structure}`;
    case 'guard': return `guard ${intent.player}`;
    case 'sortChests': return intent.category && intent.category !== 'all' ? `sort ${intent.category} into chests` : 'organize and store items into chests';
    case 'hunt': return `hunt ${intent.count || 1} ${intent.target}`;
    case 'breed': return `breed ${intent.target}`;
    case 'skill': return `run skill ${intent.id}`;
    case 'skills': return intent.query ? `search skills for ${intent.query}` : 'list the skill catalog';
    case 'think': return `reason about ${intent.goal}`;
    case 'solve': return `work out and do ${intent.goal}`;
    case 'recognize': return 'recognize what is nearby';
    case 'research': return `research ${intent.topic}`;
    case 'knowledge': return intent.query ? `recall knowledge about ${intent.query}` : 'report learned knowledge';
    case 'train': return intent.action === 'stop' ? 'stop self-training' : intent.action === 'status' ? 'report self-training status' : 'train itself from the web';
    default: return intent.type;
  }
}

function inventoryFromList(list) {
  const counts = {};
  for (const entry of list || []) {
    if (!entry || !entry.name) continue;
    counts[entry.name] = (counts[entry.name] || 0) + (entry.count || 1);
  }
  return counts;
}

function total(inventory, names) {
  if (!inventory) return 0;
  if (typeof names === 'string') return inventory[names] || 0;
  return (names || []).reduce((sum, name) => sum + (inventory[name] || 0), 0);
}

function bestPickaxe(inventory) {
  let best = null;
  let tier = 0;
  for (const [name, count] of Object.entries(inventory || {})) {
    if (count > 0 && TOOL_TIER[name] && TOOL_TIER[name] > tier) {
      best = name;
      tier = TOOL_TIER[name];
    }
  }
  return best;
}

function hasFood(inventory) {
  return Object.entries(inventory || {}).some(([name, count]) => count > 0 && FOOD_NAMES.has(name));
}

function formatInventory(inventory, maximum = 12) {
  const entries = Object.entries(inventory || {}).filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, maximum)
    .map(([name, count]) => `${count} ${name.replace(/_/g, ' ')}`);
  return entries.length ? entries.join(', ') : 'empty';
}

function formatTime(observation) {
  if (!observation?.time) return 'unknown';
  const { timeOfDay, isDay, day } = observation.time;
  const phase = isDay ? 'day' : 'night';
  return `day ${day ?? '?'} ${phase} (${timeOfDay ?? '?'}/24000)`;
}

function parseTeachingRules(notes) {
  const rules = {
    keep: {},
    avoid: new Set(),
    prefer: {}
  };
  for (const note of notes || []) {
    const text = normalizeText(note);
    const keep = text.match(/(?:always |please )?(?:keep|save|reserve|hold)\s+(?:at least\s+)?(\d+)\s+([a-z0-9_ ]+)/);
    if (keep) {
      const item = extractItem(keep[2]);
      if (item) rules.keep[item] = Math.max(rules.keep[item] || 0, Number(keep[1]));
    }
    const avoid = text.match(/(?:dont|do not|never|avoid)\s+(?:mine|dig|break|touch|attack|kill)\s+(?:the\s+)?([a-z0-9_ ]+)/);
    if (avoid) {
      const item = extractItem(avoid[1]);
      if (item) rules.avoid.add(item);
    }
    if (text.includes('prefer') || text.includes('favorite') || text.includes('favourite')) {
      const prefer = text.match(/(?:prefer|favorite|favourite)\s+([a-z0-9_ ]+)/);
      if (prefer) {
        const item = extractItem(prefer[1]);
        if (item) rules.prefer[item] = true;
      }
    }
  }
  return rules;
}

function chooseGoal(observation, memory, options = {}) {
  const inventory = observation?.inventory || inventoryFromList(observation?.inventoryList);
  const health = Number(observation?.health ?? 20);
  const food = Number(observation?.food ?? 20);
  const hostiles = observation?.nearbyHostiles || [];
  const rules = parseTeachingRules(memory?.getNotes ? memory.getNotes() : []);
  const config = options.config || {};
  const forced = options.goal && options.goal !== 'auto' ? options.goal : null;
  const pickaxe = bestPickaxe(inventory);
  const hasSword = total(inventory, ['wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword']) > 0;
  const wood = total(inventory, [...LOG_NAMES]);
  const planks = total(inventory, [...PLANK_NAMES]);
  const cobble = total(inventory, ['cobblestone', 'cobbled_deepslate', 'blackstone']);
  const coal = total(inventory, ['coal', 'charcoal']);
  const torches = total(inventory, ['torch']);
  const iron = total(inventory, ['iron_ingot', 'raw_iron', 'iron_ore']);
  const wheat = total(inventory, ['wheat', 'wheat_seeds', 'carrot', 'potato']);
  const isNight = observation?.time?.isDay === false;
  const hasBed = observation?.nearbyBedAvailable === true || Object.entries(inventory)
    .some(([name, count]) => name.endsWith('_bed') && Number(count) > 0);

  if (health <= 10 && hostiles.length) {
    return { skill: 'survive', args: {}, reason: 'Low health with hostiles nearby', priority: 100 };
  }
  if (food <= 6) {
    if (hasFood(inventory)) return { skill: 'eat', args: {}, reason: 'Hungry', priority: 95 };
    return { skill: 'gatherFood', args: { count: 8 }, reason: 'No food while hungry', priority: 94 };
  }
  if (health <= 14 && hasFood(inventory)) {
    return { skill: 'eat', args: {}, reason: 'Healing up', priority: 90 };
  }
  if (isNight && hasBed && hostiles.length === 0 && health > 10 && food > 6) {
    return { skill: 'sleep', args: {}, reason: 'A safe bed is available at night', priority: 85 };
  }

  if (forced === 'food') return { skill: 'gatherFood', args: { count: 12 }, reason: 'Requested food grind', priority: 80 };
  if (forced === 'wood') return { skill: 'gatherWood', args: { count: 32 }, reason: 'Requested wood grind', priority: 80 };
  if (forced === 'stone') return { skill: 'mine', args: { item: 'stone', count: 32 }, reason: 'Requested stone grind', priority: 80 };
  if (forced === 'coal') return { skill: 'mine', args: { item: 'coal_ore', count: 16 }, reason: 'Requested coal grind', priority: 80 };
  if (forced === 'iron') return { skill: 'mine', args: { item: 'iron_ore', count: 12 }, reason: 'Requested iron grind', priority: 80 };
  if (forced === 'diamond') return { skill: 'mine', args: { item: 'diamond_ore', count: 4 }, reason: 'Requested diamond grind', priority: 75 };
  if (forced === 'farm') return { skill: 'farm', args: {}, reason: 'Requested farm work', priority: 80 };
  if (forced === 'build') return { skill: 'buildShelter', args: {}, reason: 'Requested shelter', priority: 80 };
  if (forced && !['auto'].includes(forced)) {
    return { skill: 'ensureItem', args: { item: forced, count: 16 }, reason: `Requested ${forced} grind`, priority: 70 };
  }

  const previousWood = memory?.getSkill?.('goal:gatherWood');
  const woodFailedRecently = previousWood?.failures > 0 &&
    /could not find reachable logs|no logs reached inventory/i.test(previousWood.lastDetail || '') &&
    Date.now() - Date.parse(previousWood.lastUsedAt || 0) < 5 * 60 * 1000;
  if (woodFailedRecently) {
    return { skill: 'explore', args: { radius: 16 }, reason: 'Wood route failed recently; moving to a new area before trying again' };
  }

  const previousMine = memory?.getSkill?.('goal:mine');
  const mineFailedRecently = previousMine?.failures > 0 &&
    /could not find reachable/i.test(previousMine.lastDetail || '') &&
    Date.now() - Date.parse(previousMine.lastUsedAt || 0) < 5 * 60 * 1000;
  if (mineFailedRecently) {
    const visibleLogs = (observation?.nearbyBlocks || []).some(block => LOG_NAMES.has(block.name));
    return visibleLogs
      ? { skill: 'gatherWood', args: { count: 16 }, reason: 'Mining route failed recently; switching to visible wood', priority: 68 }
      : { skill: 'explore', args: { radius: 16 }, reason: 'Mining route failed recently; scouting for reachable resources', priority: 68 };
  }

  if (!pickaxe) {
    if (wood + planks >= 4) {
      return { skill: 'ensureItem', args: { item: 'wooden_pickaxe', count: 1 }, reason: 'No pickaxe yet', priority: 70 };
    }
    return { skill: 'gatherWood', args: { count: 8 }, reason: 'Need wood for a pickaxe', priority: 69 };
  }
  if (!hasSword && cobble < 2) {
    return { skill: 'mine', args: { item: 'stone', count: 8 }, reason: 'Need stone for a sword', priority: 66 };
  }
  if (!hasSword) {
    return { skill: 'ensureItem', args: { item: 'stone_sword', count: 1 }, reason: 'No sword yet', priority: 65 };
  }
  if (wood + planks < 16) {
    return { skill: 'gatherWood', args: { count: 24 }, reason: 'Low on wood', priority: 60 };
  }
  if (cobble < 24) {
    return { skill: 'mine', args: { item: 'stone', count: 32 }, reason: 'Low on stone', priority: 58 };
  }
  if (coal < 8) {
    return { skill: 'mine', args: { item: 'coal_ore', count: 16 }, reason: 'Low on coal', priority: 56 };
  }
  if (torches < 8) {
    return { skill: 'ensureItem', args: { item: 'torch', count: 16 }, reason: 'Need light for the base', priority: 54 };
  }
  if (iron < 6 && ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(pickaxe)) {
    return { skill: 'mine', args: { item: 'iron_ore', count: 12 }, reason: 'Need iron', priority: 52 };
  }
  if (isNight && !observation?.shelter) {
    return { skill: 'buildShelter', args: {}, reason: 'Night is coming', priority: 50 };
  }
  if (wheat > 0 && total(inventory, ['wheat_seeds']) > 0) {
    return { skill: 'farm', args: {}, reason: 'Tend the farm', priority: 30 };
  }
  if (rules.keep && Object.keys(rules.keep).length) {
    for (const [item, amount] of Object.entries(rules.keep)) {
      if (total(inventory, item) < amount) {
        return { skill: 'ensureItem', args: { item, count: amount }, reason: `Teaching rule: keep ${amount} ${item}`, priority: 48 };
      }
    }
  }
  if (config.digForOres && iron < 12) {
    return { skill: 'mine', args: { item: 'iron_ore', count: 8 }, reason: 'Explore for iron', priority: 25 };
  }
  return { skill: 'explore', args: { radius: 24 }, reason: 'Scout for resources', priority: 10 };
}

function describeGoal(goal) {
  if (!goal) return 'idle';
  const item = goal.args?.item ? ` ${goal.args.item.replace(/_/g, ' ')}` : '';
  const count = goal.args?.count ? ` x${goal.args.count}` : '';
  switch (goal.skill) {
    case 'eat': return 'eating';
    case 'gatherFood': return 'hunting for food';
    case 'gatherWood': return `chopping wood${count}`;
    case 'mine': return `mining${item}${count}`;
    case 'ensureItem': return `crafting${item}${count}`;
    case 'buildShelter': return 'building a shelter';
    case 'farm': return 'working the farm';
    case 'explore': return 'scouting';
    case 'survive': return 'surviving';
    default: return goal.skill.replace(/([A-Z])/g, ' $1').toLowerCase();
  }
}

function recipeAnswer(item) {
  const name = canonicalItem(item || '');
  if (RECIPE_GUIDE[name]) return RECIPE_GUIDE[name];
  if (name.endsWith('_planks')) return '1 matching log -> 4 planks.';
  if (name.endsWith('_pickaxe')) {
    const material = name.replace('_pickaxe', '');
    return `3 ${material} + 2 sticks at a crafting table.`;
  }
  if (name.endsWith('_sword')) {
    const material = name.replace('_sword', '');
    return `2 ${material} + 1 stick at a crafting table.`;
  }
  if (name.endsWith('_axe')) {
    const material = name.replace('_axe', '');
    return `3 ${material} + 2 sticks at a crafting table.`;
  }
  if (name.endsWith('_shovel')) {
    const material = name.replace('_shovel', '');
    return `1 ${material} + 2 sticks at a crafting table.`;
  }
  return '';
}

function evaluateMath(expression) {
  try {
    const cleaned = String(expression || '')
      .replace(/x/gi, '*')
      .replace(/[^0-9+\-*/().\s]/g, '')
      .trim();
    if (!cleaned || !/^[0-9(]/.test(cleaned) || !/[0-9)]$/.test(cleaned)) return null;
    if (/[^0-9+\-*/().\s]/.test(cleaned)) return null;
    // Safe restricted evaluation of basic math
    const result = Function(`"use strict"; return (${cleaned});`)();
    if (typeof result === 'number' && Number.isFinite(result)) {
      const rounded = Math.round(result * 100) / 100;
      const stackCount = Math.floor(rounded / 64);
      const remainder = rounded % 64;
      const stackNote = (rounded >= 64 && rounded % 1 === 0)
        ? ` (${stackCount} stack${stackCount === 1 ? '' : 's'}${remainder > 0 ? ` + ${remainder}` : ''})`
        : '';
      return `${cleaned} = ${rounded}${stackNote}`;
    }
  } catch {}
  return null;
}

const MINECRAFT_JOKES = [
  'Why can’t the Ender Dragon read a book? Because she always starts at the End!',
  'Why did the creeper cross the road? To get to the player on the other side and hiss!',
  'What is a creeper’s favorite school subject? Hiss-tory!',
  'Why do skeletons stay so relaxed? Because nothing gets under their skin!',
  'How does Steve get his exercise? Running around the block!',
  'Why did the zombie go to school? To improve his brain food!'
];

function answerKnownQuestion(rawText, observation, memory) {
  const text = normalizeText(rawText);

  // 1. Math and stack calculations
  const stackMatch = text.match(/(?:how many(?: items)? is|how much is)\s+(\d+)\s+stacks?/i);
  if (stackMatch) {
    const stacks = Number(stackMatch[1]);
    return `${stacks} stack${stacks === 1 ? '' : 's'} is ${stacks * 64} items.`;
  }
  const itemsToStackMatch = text.match(/(?:how many stacks? is|stacks? in)\s+(\d+)(?:\s+items?)?/i);
  if (itemsToStackMatch) {
    const items = Number(itemsToStackMatch[1]);
    const stacks = Math.floor(items / 64);
    const rem = items % 64;
    return `${items} items is ${stacks} stack${stacks === 1 ? '' : 's'}${rem > 0 ? ` and ${rem} items` : ''}.`;
  }
  const mathExpr = String(rawText || '').match(/(?:what is|calculate|solve|how much is)\s+([0-9\s+\-*/x%()^.]+)/i) ||
    String(rawText || '').match(/^([0-9\s+\-*/x%()^.]+)$/);
  if (mathExpr) {
    const mathAnswer = evaluateMath(mathExpr[1]);
    if (mathAnswer) return mathAnswer;
  }

  // 2. Greetings and pleasantries
  if (/^(?:hi|hello|hey|yo|sup|hiya|good morning|good evening)\b/.test(text)) {
    return 'Hey! I am Virgo, your autonomous Minecraft AI companion. Ask me anything, or give me a task like mining, crafting, or building!';
  }
  if (/^(?:thanks|thank you|ty|nice|good job|well done|great|awesome|cool)\b/.test(text)) {
    return 'You are welcome! Happy to help you survive and build.';
  }
  if (/^(?:how are you|how is it going|how are you doing|how do you feel)\b/.test(text)) {
    return `Doing great! Health is ${observation?.health ?? '20'}/20, food is ${observation?.food ?? '20'}/20, located at ${formatPosition(observation)}. Ready for the next adventure!`;
  }

  // 3. Identity and capabilities
  if (/^(?:who are you|what is your name|introduce yourself)\b/.test(text)) {
    return 'I am Virgo, an autonomous Minecraft AI companion! I can mine, craft, smelt, build shelters, fight mobs, farm, explore, and answer your questions 24/7.';
  }
  if (/^(?:who made you|who created you|who is your creator|who built you)\b/.test(text)) {
    return 'I was created by Mr.Juice3046 and enhanced with advanced AI cognitive reasoning by Lamgerr and VirgoYT.';
  }
  if (/^(?:what can you do|what are your skills|what are your abilities|help me)\b/.test(text)) {
    return 'I can mine ores, chop trees, recursively craft recipes, smelt in furnaces, build survival shelters, fight hostiles, farm crops, fish, store/deliver items, and compile multi-step tactical plans!';
  }
  if (/^(?:what (?:is your )?model|show model|neural model|what ai are you)\b/.test(text)) {
    return 'I run a dual-engine architecture: a compiled A-to-Z cognitive deliberation engine plus a local self-trained neural network (3-layer policy network + language intent network). You can have me train it further anytime.';
  }
  if (/^(?:are you an ai|are you real|are you a bot|are you human)\b/.test(text)) {
    return 'I am an autonomous Minecraft AI agent equipped with cognitive chain-of-thought deliberation, local intent parsing, and deterministic game actions.';
  }
  if (/^(?:tell me a joke|tell a joke|make me laugh|joke)\b/.test(text)) {
    return MINECRAFT_JOKES[Math.floor(Math.random() * MINECRAFT_JOKES.length)];
  }
  if (/^(?:what is your favorite|do you like)\s+(?:item|block|weapon)\b/.test(text)) {
    return 'My favorite is the diamond pickaxe! It mines fast, lasts for thousands of blocks, and unlocks all the best gear.';
  }
  if (/^(?:give me a tip|survival tip|pro tip|advice)\b/.test(text)) {
    const tips = [
      'Pro tip: Always carry a water bucket on your hotbar! It negates fall damage, douses fire, and turns lava into obsidian.',
      'Pro tip: Torches on the right side of the cave wall when exploring; follow them on your left to find your way back out!',
      'Pro tip: Place a shield in your off-hand. It completely blocks creeper blasts and skeleton arrows.',
      'Pro tip: Never dig straight down or straight up! Stand on the border between two blocks and dig alternately.'
    ];
    return tips[Math.floor(Math.random() * tips.length)];
  }

  // 4. In-game sensory and vital checks
  if (/^(?:inventory|inv|what do you have|what is in your inventory|items)\b/.test(text)) {
    return `I have ${formatInventory(observation?.inventory || inventoryFromList(observation?.inventoryList))}.`;
  }
  if (/^(?:where are you|coords|coordinates|position|where)\b/.test(text)) {
    return `I am at ${formatPosition(observation)}.`;
  }
  if (/^(?:health|hp|how much health|are you hurt)\b/.test(text)) {
    return `Health is ${observation?.health ?? '?'}/20, food is ${observation?.food ?? '?'}/20.`;
  }
  if (/^(?:food|hunger|are you hungry)\b/.test(text)) {
    return `Food is ${observation?.food ?? '?'}/20. ${Number(observation?.food ?? 20) <= 6 ? 'I should eat soon.' : 'I am okay.'}`;
  }
  if (/^(?:time|what time is it|is it day|is it night)\b/.test(text)) {
    return `It is ${formatTime(observation)}.`;
  }
  if (/^(?:dimension|what dimension|where am i)\b/.test(text)) {
    return `Current dimension: ${observation?.dimension || 'Overworld'}.`;
  }
  if (/^(?:weather|is it raining|is it stormy)\b/.test(text)) {
    return observation?.weather?.raining ? 'It is currently raining!' : 'Weather is clear.';
  }
  if (/^(?:players|who is online|who is here)\b/.test(text)) {
    const players = Object.keys(observation?.players || {});
    return players.length ? `Online: ${players.join(', ')}.` : 'I do not see other players nearby.';
  }
  if (/^(?:nearby|what is nearby|surroundings|see)\b/.test(text)) {
    const blocks = (observation?.nearbyBlocks || []).slice(0, 10).map(entry =>
      typeof entry === 'string' ? entry : `${entry.name} (${entry.distance}m)`);
    const mobs = (observation?.nearbyHostiles || []).slice(0, 5).map(entry => entry.name || entry);
    return `Nearby blocks: ${blocks.join(', ') || 'none'}. ${mobs.length ? `Hostiles: ${mobs.join(', ')}.` : 'No hostiles close.'}`;
  }
  if (/^(?:stats|skills|what have you learned|memory)\b/.test(text)) {
    const skills = (memory?.getSkills ? memory.getSkills() : []).slice(-6)
      .map(skill => `${skill.name} ${skill.successes}/${skill.attempts}`);
    return skills.length ? `Skill record: ${skills.join(', ')}.` : 'I have not recorded any skills yet.';
  }

  // 5. Minecraft Lore, Mechanics & Facts
  for (const [pattern, answer] of MC_FACTS) {
    if (pattern.test(text)) return answer;
  }

  // 6. Recipe lookups
  const recipe = text.match(/(?:how (?:do|can) i (?:make|craft|get)|what (?:do i need|are the ingredients) (?:for|to make))\s+(?:a|an|the)?\s*(.+)$/);
  if (recipe) {
    const answer = recipeAnswer(extractItem(recipe[1]) || cleanItemPhrase(recipe[1]));
    if (answer) return answer;
  }

  // 7. General suggestion
  if (/^(?:what should (?:i|we) (?:do|build)|any ideas)\b/.test(text)) {
    const suggestions = [
      'We could establish an underground automated iron farm or crop farm for infinite food!',
      'How about going on an expedition to find a Nether Fortress and gather blaze rods?',
      'We could dig a strip mine at Y=-58 to hunt for diamonds and ancient debris!',
      'We could build a secure perimeter wall with torches around our base to stop mob spawns.'
    ];
    return suggestions[Math.floor(Math.random() * suggestions.length)];
  }

  return '';
}

function formatPosition(observation) {
  const position = observation?.position;
  if (!position) return 'an unknown position';
  return `${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)}`;
}

function suggestNext(observation, memory) {
  const goal = chooseGoal(observation, memory, {});
  return `Next: ${describeGoal(goal)} (${goal.reason}).`;
}

module.exports = {
  ANIMALS,
  BREED_FOODS,
  COOKED_FOOD,
  FOOD_NAMES,
  HOSTILE_MOBS,
  ITEM_ALIASES,
  LOG_NAMES,
  MAX_TASK_COUNT,
  MC_FACTS,
  PICKAXE_BY_TIER,
  PLANK_NAMES,
  RAW_TO_COOKED,
  RECIPE_GUIDE,
  TOOL_TIER,
  answerKnownQuestion,
  bestPickaxe,
  canonicalItem,
  chooseGoal,
  cleanItemPhrase,
  describeGoal,
  describeIntent,
  extractItem,
  formatInventory,
  formatPosition,
  formatTime,
  hasFood,
  inventoryFromList,
  isFood,
  isLog,
  isPlank,
  normalizeText,
  parseCount,
  parseLocalIntent,
  parseTeachingRules,
  planForIntent,
  plankForLog,
  recipeAnswer,
  suggestNext,
  total
};
