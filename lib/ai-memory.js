'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_MEMORY_NOTES = 100;
const MAX_MEMORY_NOTE_LENGTH = 300;
const MAX_MEMORY_FACTS = 100;
const MAX_MEMORY_WAYPOINTS = 100;
const MAX_MEMORY_SKILLS = 80;
const MAX_MEMORY_PLAYERS = 50;
const MAX_PLAYER_NOTES = 20;
const MAX_VALUE_LENGTH = 500;
const DEFAULT_MEMORY_PATH = path.resolve(__dirname, '..', 'data', 'ai-memory.json');

function clampString(value, maximum = MAX_VALUE_LENGTH) {
  return typeof value === 'string' ? value.slice(0, maximum) : value;
}

function safeKey(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  const key = value.trim();
  if (!key || key.length > 120) throw new Error(`${label} must be between 1 and 120 characters.`);
  return key;
}

class AIMemory {
  constructor(filePath = DEFAULT_MEMORY_PATH, maxNotes = MAX_MEMORY_NOTES) {
    if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > 500) {
      throw new Error('AI memory limit must be an integer from 1 to 500 notes.');
    }
    this.filePath = filePath;
    this.maxNotes = maxNotes;
    this.notes = [];
    this.facts = {};
    this.waypoints = {};
    this.skills = {};
    this.players = {};
    this.stats = {};
    this.read();
  }

  getNotes() {
    return this.notes.map(entry => entry.note);
  }

  addNote(value) {
    if (typeof value !== 'string') throw new TypeError('AI memory notes must be text.');
    const note = value.trim();
    if (!note || note.length > MAX_MEMORY_NOTE_LENGTH) {
      throw new Error(`AI memory notes must be between 1 and ${MAX_MEMORY_NOTE_LENGTH} characters.`);
    }

    this.notes = [...this.notes, { note, recordedAt: new Date().toISOString() }].slice(-this.maxNotes);
    this.write();
    return note;
  }

  clearAll() {
    this.notes = [];
    this.facts = {};
    this.waypoints = {};
    this.skills = {};
    this.players = {};
    this.stats = {};
    this.write();
  }

  removeNotesMatching(value) {
    if (typeof value !== 'string') throw new TypeError('AI memory search text must be text.');
    const needle = value.trim().toLowerCase();
    if (!needle) return 0;
    const before = this.notes.length;
    this.notes = this.notes.filter(entry => !entry.note.toLowerCase().includes(needle));
    const removed = before - this.notes.length;
    if (removed > 0) this.write();
    return removed;
  }

  getFacts() {
    return { ...this.facts };
  }

  getFact(key, fallback = null) {
    const normalized = safeKey(key, 'Fact key');
    return Object.prototype.hasOwnProperty.call(this.facts, normalized) ? this.facts[normalized] : fallback;
  }

  setFact(key, value) {
    const normalized = safeKey(key, 'Fact key');
    if (value === undefined) throw new TypeError('Fact values cannot be undefined.');
    this.facts[normalized] = this.normalizeValue(value);
    const keys = Object.keys(this.facts);
    if (keys.length > MAX_MEMORY_FACTS) {
      for (const stale of keys.slice(0, keys.length - MAX_MEMORY_FACTS)) delete this.facts[stale];
    }
    this.write();
    return this.facts[normalized];
  }

  deleteFact(key) {
    const normalized = safeKey(key, 'Fact key');
    delete this.facts[normalized];
    this.write();
  }

  recordChest(position, items = []) {
    if (!position) return;
    const key = `chest_${Math.floor(position.x)}_${Math.floor(position.y)}_${Math.floor(position.z)}`;
    const cleanItems = Array.isArray(items)
      ? items.filter(it => it && it.name).map(it => ({ name: it.name, count: it.count || 1 }))
      : [];
    this.facts[key] = {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
      items: cleanItems,
      updatedAt: new Date().toISOString()
    };
    this.write();
    return this.facts[key];
  }

  findItemInChests(itemName) {
    const canonical = String(itemName || '').toLowerCase().replace(/\s+/g, '_');
    const matches = [];
    for (const [key, fact] of Object.entries(this.facts)) {
      if (!key.startsWith('chest_') || !Array.isArray(fact?.items)) continue;
      for (const it of fact.items) {
        if (it.name === canonical || it.name.includes(canonical)) {
          matches.push({
            chest: { x: fact.x, y: fact.y, z: fact.z },
            name: it.name,
            count: it.count,
            updatedAt: fact.updatedAt
          });
        }
      }
    }
    return matches;
  }

  listKnownChests() {
    return Object.entries(this.facts)
      .filter(([k]) => k.startsWith('chest_'))
      .map(([_, v]) => v);
  }

  addWaypoint(name, position, meta = {}) {
    const key = safeKey(name, 'Waypoint name');
    if (!position || !['x', 'y', 'z'].every(axis => Number.isFinite(Number(position[axis])))) {
      throw new TypeError('Waypoint positions need finite x, y, and z values.');
    }
    this.waypoints[key] = {
      x: Math.floor(Number(position.x)),
      y: Math.floor(Number(position.y)),
      z: Math.floor(Number(position.z)),
      dimension: typeof position.dimension === 'string' ? position.dimension : null,
      meta: this.normalizeValue(meta),
      recordedAt: new Date().toISOString()
    };
    const keys = Object.keys(this.waypoints);
    if (keys.length > MAX_MEMORY_WAYPOINTS) {
      for (const stale of keys.slice(0, keys.length - MAX_MEMORY_WAYPOINTS)) delete this.waypoints[stale];
    }
    this.write();
    return this.waypoints[key];
  }

  getWaypoint(name) {
    const key = safeKey(name, 'Waypoint name');
    return this.waypoints[key] || null;
  }

  listWaypoints() {
    return Object.entries(this.waypoints).map(([name, waypoint]) => ({ name, ...waypoint }));
  }

  removeWaypoint(name) {
    const key = safeKey(name, 'Waypoint name');
    delete this.waypoints[key];
    this.write();
  }

  recordSkill(name, { success = false, durationMs = 0, detail = '' } = {}) {
    const key = safeKey(name, 'Skill name');
    const current = this.skills[key] || {
      attempts: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      lastUsedAt: null,
      lastDetail: ''
    };
    const attempts = current.attempts + 1;
    this.skills[key] = {
      attempts,
      successes: current.successes + (success ? 1 : 0),
      failures: current.failures + (success ? 0 : 1),
      totalDurationMs: current.totalDurationMs + Math.max(0, Math.floor(durationMs || 0)),
      averageDurationMs: Math.round((current.totalDurationMs + Math.max(0, Math.floor(durationMs || 0))) / attempts),
      lastUsedAt: new Date().toISOString(),
      lastDetail: clampString(String(detail || ''), MAX_VALUE_LENGTH)
    };
    const keys = Object.keys(this.skills);
    if (keys.length > MAX_MEMORY_SKILLS) {
      const oldest = keys
        .sort((left, right) => String(this.skills[left].lastUsedAt).localeCompare(String(this.skills[right].lastUsedAt)))
        .slice(0, keys.length - MAX_MEMORY_SKILLS);
      for (const stale of oldest) delete this.skills[stale];
    }
    this.write();
    return this.skills[key];
  }

  getSkill(name) {
    return this.skills[safeKey(name, 'Skill name')] || null;
  }

  getSkills() {
    return Object.entries(this.skills).map(([name, stats]) => ({ name, ...stats }));
  }

  addPlayerNote(player, note) {
    const name = safeKey(player, 'Player name').toLowerCase();
    if (typeof note !== 'string' || !note.trim()) throw new Error('Player notes must be non-empty text.');
    const current = this.players[name] || { notes: [], lastSeenAt: null };
    const notes = [...current.notes, {
      note: clampString(note.trim(), MAX_MEMORY_NOTE_LENGTH),
      recordedAt: new Date().toISOString()
    }].slice(-MAX_PLAYER_NOTES);
    this.players[name] = {
      notes,
      lastSeenAt: new Date().toISOString()
    };
    const keys = Object.keys(this.players);
    if (keys.length > MAX_MEMORY_PLAYERS) {
      const oldest = keys
        .sort((left, right) => String(this.players[left].lastSeenAt).localeCompare(String(this.players[right].lastSeenAt)))
        .slice(0, keys.length - MAX_MEMORY_PLAYERS);
      for (const stale of oldest) delete this.players[stale];
    }
    this.write();
    return this.players[name];
  }

  getPlayerNotes(player) {
    const name = safeKey(player, 'Player name').toLowerCase();
    return (this.players[name]?.notes || []).map(entry => entry.note);
  }

  getPlayers() {
    return Object.entries(this.players).map(([name, data]) => ({ name, ...data }));
  }

  incrementStat(name, amount = 1) {
    const key = safeKey(name, 'Stat name');
    this.stats[key] = (this.stats[key] || 0) + Number(amount || 0);
    this.write();
    return this.stats[key];
  }

  getStats() {
    return { ...this.stats };
  }

  summaryForPrompt(maximum = 1200) {
    const lines = [];
    const facts = Object.entries(this.facts).slice(-20);
    if (facts.length) {
      lines.push('Known facts:');
      for (const [key, value] of facts) lines.push(`- ${key}: ${this.describeValue(value)}`);
    }
    const waypoints = this.listWaypoints().slice(-10);
    if (waypoints.length) {
      lines.push('Known places:');
      for (const waypoint of waypoints) lines.push(`- ${waypoint.name}: ${waypoint.x}, ${waypoint.y}, ${waypoint.z}`);
    }
    const skills = this.getSkills().slice(-10);
    if (skills.length) {
      lines.push('Skill history:');
      for (const skill of skills) {
        const rate = skill.attempts ? Math.round((skill.successes / skill.attempts) * 100) : 0;
        lines.push(`- ${skill.name}: ${skill.successes}/${skill.attempts} (${rate}%)`);
      }
    }
    const notes = this.getNotes().slice(-10);
    if (notes.length) {
      lines.push('Recent notes:');
      for (const note of notes) lines.push(`- ${note}`);
    }
    return lines.join('\n').slice(0, maximum);
  }

  describeValue(value) {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  normalizeValue(value, depth = 0) {
    if (depth > 3) return '[nested]';
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return clampString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 40).map(entry => this.normalizeValue(entry, depth + 1));
    if (typeof value === 'object') {
      const normalized = {};
      for (const [key, entry] of Object.entries(value).slice(0, 40)) {
        normalized[clampString(key, 80)] = this.normalizeValue(entry, depth + 1);
      }
      return normalized;
    }
    return String(value);
  }

  read() {
    let content;
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw new Error(`Could not read local AI memory: ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`Local AI memory is not valid JSON: ${error.message}`);
    }
    if (!parsed || !Array.isArray(parsed.notes)) {
      throw new Error('Local AI memory must contain a notes array.');
    }
    this.notes = parsed.notes.map(entry => {
      if (!entry || typeof entry.note !== 'string' || typeof entry.recordedAt !== 'string') {
        throw new Error('Local AI memory contains an invalid note entry.');
      }
      return {
        note: entry.note.slice(0, MAX_MEMORY_NOTE_LENGTH),
        recordedAt: entry.recordedAt
      };
    }).slice(-this.maxNotes);
    this.facts = this.readObject(parsed.facts, 'facts');
    this.waypoints = this.readObject(parsed.waypoints, 'waypoints');
    this.skills = this.readObject(parsed.skills, 'skills');
    this.players = this.readObject(parsed.players, 'players');
    this.stats = this.readObject(parsed.stats, 'stats');
  }

  readObject(value, label) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Local AI memory field "${label}" must be an object.`);
    }
    return value;
  }

  write() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const payload = {
      version: 2,
      notes: this.notes,
      facts: this.facts,
      waypoints: this.waypoints,
      skills: this.skills,
      players: this.players,
      stats: this.stats,
      updatedAt: new Date().toISOString()
    };
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, this.filePath);
  }
}

module.exports = {
  AIMemory,
  MAX_MEMORY_NOTE_LENGTH,
  MAX_MEMORY_NOTES
};
