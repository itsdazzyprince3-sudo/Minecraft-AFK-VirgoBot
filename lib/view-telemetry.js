'use strict';

const VIEWER_ENDPOINTS = new Set(['/frame', '/state.json']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DIRECTIONS = ['South', 'West', 'North', 'East'];

function getLocalViewerUrl(endpoint, rawUrl = 'http://127.0.0.1:8080') {
  if (!VIEWER_ENDPOINTS.has(endpoint)) {
    throw new TypeError('Unsupported local viewer endpoint.');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError('Viewer URL is invalid.');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new TypeError('Viewer proxy only accepts an HTTP viewer bound to localhost.');
  }
  url.pathname = endpoint;
  url.search = '';
  url.hash = '';
  return url;
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildViewTelemetry({ renderer = {}, bot, grid = null } = {}) {
  const position = bot?.entity?.position;
  if (!position || ![position.x, position.y, position.z].every(value => Number.isFinite(Number(value)))) {
    throw new TypeError('Bot position is unavailable.');
  }
  const yaw = finiteOrNull(bot.entity.yaw) ?? 0;
  const pitch = finiteOrNull(bot.entity.pitch) ?? 0;
  let block = null;
  try {
    block = bot.blockAt?.({
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z)
    }) || null;
  } catch {
    block = null;
  }
  const directionIndex = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return {
    ...renderer,
    connected: true,
    position: { x: Number(position.x), y: Number(position.y), z: Number(position.z) },
    yawRadians: yaw,
    pitchRadians: pitch,
    yawDegrees: yaw * 180 / Math.PI,
    pitchDegrees: pitch * 180 / Math.PI,
    facing: DIRECTIONS[directionIndex],
    dimension: bot.game?.dimension || 'unknown',
    timeOfDay: finiteOrNull(bot.time?.timeOfDay),
    day: finiteOrNull(bot.time?.day),
    health: finiteOrNull(bot.health),
    food: finiteOrNull(bot.food),
    heldItem: bot.heldItem?.name || null,
    quickBarSlot: Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0,
    block: block?.name || null,
    blockLight: finiteOrNull(block?.light),
    skyLight: finiteOrNull(block?.skyLight),
    biome: block?.biome?.name || null,
    grid: Array.isArray(grid) ? grid : null
  };
}

module.exports = { buildViewTelemetry, getLocalViewerUrl };
