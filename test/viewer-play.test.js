'use strict';

// Camera (POV), F3 debug data, lighting, inventory and the new control paths of the browser view.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Vec3 } = require('vec3');
const conversions = require('mineflayer/lib/conversions');
const camera = require('../lib/viewer-camera');
const { BrowserViewer, facingOf, notchianYawDegrees, skyBrightness } = require('../lib/browser-viewer');

let ioClient = null;
try { ioClient = require('socket.io-client').io; } catch { /* optional */ }

const emitAck = (socket, event, payload) => new Promise(resolve => {
  if (payload === undefined) socket.emit(event, resolve); else socket.emit(event, payload, resolve);
});
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------ compass
test('facing follows mineflayer yaw: 0 north, pi/2 west, pi south, 3pi/2 east', () => {
  assert.equal(facingOf(0).name, 'north');
  assert.equal(facingOf(Math.PI / 2).name, 'west');
  assert.equal(facingOf(Math.PI).name, 'south');
  assert.equal(facingOf(1.5 * Math.PI).name, 'east');
  assert.equal(facingOf(-Math.PI / 2).name, 'east');           // negative yaw wraps
  assert.equal(facingOf(2 * Math.PI + 0.1).name, 'north');
});

test('facing agrees with the direction mineflayer actually looks in', () => {
  // mineflayer/lib/plugins/ray_trace.js: direction = (-sin yaw, ., -cos yaw)
  const axes = { north: ['z', -1], south: ['z', 1], west: ['x', -1], east: ['x', 1] };
  for (let yaw = 0; yaw < 2 * Math.PI; yaw += Math.PI / 8) {
    const dir = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const [axis, sign] = axes[facingOf(yaw).name];
    assert.ok(dir[axis] * sign > 0.38, `yaw ${yaw} faces ${facingOf(yaw).name} but looks along ${JSON.stringify(dir)}`);
  }
});

test('F3 yaw degrees match the game (0 south, 90 west, +-180 north, -90 east) and mineflayer conversions', () => {
  assert.ok(close(notchianYawDegrees(Math.PI), 0));
  assert.ok(close(notchianYawDegrees(Math.PI / 2), 90));
  assert.ok(close(Math.abs(notchianYawDegrees(0)), 180));
  assert.ok(close(notchianYawDegrees(1.5 * Math.PI), -90));
  for (const yaw of [0.3, 1, 2.5, 4, 5.9]) {
    const expected = ((((conversions.toNotchianYaw(yaw) + 180) % 360) + 360) % 360) - 180;
    assert.ok(close(notchianYawDegrees(yaw), expected, 1e-6), `yaw ${yaw}`);
  }
});

test('sky brightness: full by day, dark at night, ramps at dusk and dawn', () => {
  assert.equal(skyBrightness(6000), 1);
  assert.equal(skyBrightness(12000), 1);
  const dusk = skyBrightness(13000);
  assert.ok(dusk > 0 && dusk < 1);
  assert.equal(skyBrightness(15000), 0);
  assert.equal(skyBrightness(18000), 0);
  const dawn = skyBrightness(23000);
  assert.ok(dawn > 0 && dawn < 1);
  assert.equal(skyBrightness(24000), 1);
  assert.equal(skyBrightness(30000), 1);       // wraps
  assert.equal(skyBrightness(NaN), 1);
});

// ------------------------------------------------------------------ camera
test('first person camera is exactly the eye', () => {
  const pose = camera.cameraPose([1, 65.6, 3], 0.7, -0.2, 0);
  assert.deepEqual(pose, { pos: [1, 65.6, 3], yaw: 0.7, pitch: -0.2 });
});

test('third person back sits behind the head and looks at it; front sits ahead looking back', () => {
  const eye = [10, 65.6, -4];
  for (const [yaw, pitch] of [[0, 0], [0.8, 0.3], [2.4, -0.5], [4.5, 0.1]]) {
    for (const pov of [1, 2]) {
      const pose = camera.cameraPose(eye, yaw, pitch, pov, 4, 4);
      const forward = camera.viewDir(pose.yaw, pose.pitch);
      const reached = pose.pos.map((v, i) => v + forward[i] * camera.MAX_DISTANCE);
      reached.forEach((v, i) => assert.ok(close(v, eye[i], 1e-9), `pov ${pov} yaw ${yaw}: ${reached} != ${eye}`));
    }
  }
  const back = camera.cameraPose([0, 0, 0], 0, 0, 1, 4, 4);       // facing north: behind is +Z
  assert.ok(close(back.pos[2], 4) && close(back.pos[0], 0));
  const front = camera.cameraPose([0, 0, 0], 0, 0, 2, 4, 4);
  assert.ok(close(front.pos[2], -4));
  assert.ok(close(front.yaw, Math.PI));
});

test('third person camera stops short of walls and never goes inside the head', () => {
  assert.ok(close(camera.cameraPose([0, 0, 0], 0, 0, 1, 1.5, 4).pos[2], 1.5));
  assert.ok(close(camera.cameraPose([0, 0, 0], 0, 0, 1, 0.01, 4).pos[2], 0.3));
  assert.ok(close(camera.cameraPose([0, 0, 0], 0, 0, 1, 99, 4).pos[2], camera.MAX_DISTANCE));
  assert.ok(close(camera.cameraPose([0, 0, 0], 0, 0, 2, 4, 2).pos[2], -2));
  assert.ok(close(camera.cameraPose([0, 0, 0], 0, 0, 1, undefined, undefined).pos[2], camera.MAX_DISTANCE));
});

// ------------------------------------------------------------------ lighting
test('lighting: full bright ignores the world, day is untouched, night and caves are darker', () => {
  const day = { connected: true, skyBrightness: 1, light: { known: true, eff: 15, sky: 15, block: 0 } };
  const night = { connected: true, skyBrightness: 0, light: { known: true, eff: 0, sky: 15, block: 0 } };
  const cave = { connected: true, skyBrightness: 1, light: { known: true, eff: 0, sky: 0, block: 0 } };
  const torch = { connected: true, skyBrightness: 1, light: { known: true, eff: 14, sky: 0, block: 14 } };

  const bright = camera.lightingTarget(night, 'bright');
  assert.equal(bright.ambient, 1);
  assert.equal(bright.sun, 1);
  assert.deepEqual(camera.lightingTarget(null, 'auto').color, [0.47, 0.65, 1.0]);

  const d = camera.lightingTarget(day, 'auto');
  assert.ok(close(d.ambient, 1) && close(d.sun, 1));
  const n = camera.lightingTarget(night, 'auto');
  assert.ok(n.ambient < d.ambient && n.sun === 0);
  assert.ok(n.color[2] < d.color[2], 'night sky is darker than day sky');
  const c = camera.lightingTarget(cave, 'auto');
  assert.ok(c.ambient <= 0.21 && c.sun < d.sun);
  assert.ok(c.color[0] < 0.1, 'no sky colour overhead in a cave');
  const t = camera.lightingTarget(torch, 'auto');
  assert.ok(t.ambient > 0.9 && t.ambient > c.ambient, 'a torch-lit cave is bright');
});

test('lighting without server light data falls back to the time of day, not pitch black', () => {
  const unknownDay = camera.lightingTarget({ connected: true, skyBrightness: 1, light: { known: false, eff: 0, sky: 0, block: 0 } }, 'auto');
  assert.ok(close(unknownDay.ambient, 1));
  assert.ok(unknownDay.color[2] > 0.9);
  const unknownNight = camera.lightingTarget({ connected: true, skyBrightness: 0, light: { known: false, eff: 0, sky: 0, block: 0 } }, 'auto');
  assert.ok(unknownNight.ambient > 0.4 && unknownNight.ambient < 0.5);
});

// ------------------------------------------------------------------ server state
function fakeBot(overrides = {}) {
  const slots = new Array(46).fill(null);
  slots[36] = { name: 'diamond_pickaxe', count: 1 };
  slots[10] = { name: 'cobblestone', count: 64 };
  slots[45] = { name: 'shield', count: 1 };
  const listeners = {};
  const lightBlock = { name: 'air', light: 4, skyLight: 15, biome: { name: 'plains' } };
  return {
    listeners,
    version: '1.21.4',
    username: 'Virgo',
    health: 20, food: 20, quickBarSlot: 0, foodSaturation: 5, oxygenLevel: 300,
    experience: { level: 0, progress: 0 },
    entity: { id: 7, position: new Vec3(-1.5, -63, 17.2), yaw: 0, pitch: 0, effects: {}, velocity: new Vec3(0, 0, 0), onGround: true, eyeHeight: 1.62, width: 0.6, height: 1.8 },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000, day: 3 },
    isRaining: false,
    entities: { 1: {}, 2: {} },
    inventory: { slots },
    world: { getColumns: () => [1, 2, 3], raycast: () => null },
    blockAt: () => lightBlock,
    blockAtCursor: () => ({ name: 'grass_block', position: new Vec3(3, 63, 17), face: 1, getProperties: () => ({ snowy: 'false' }) }),
    entityAtCursor: () => ({ name: 'zombie', position: new Vec3(-1.5, -63, 20.2) }),
    aiPerception: { fps: 58, freeCenter: 80, freeLeft: 60, freeRight: 70, forwardClear: 4.2, nearest: 3.1, receivedAt: Date.now() },
    on(name, fn) { listeners[name] = fn; },
    removeListener(name) { delete listeners[name]; },
    ...overrides
  };
}

test('hudState reports real light, sky brightness and only fills debug/inventory when asked', () => {
  const viewer = new BrowserViewer({ token: 't', log: () => {}, eyesUrl: 'http://127.0.0.1:8080' });
  viewer.attach(fakeBot());
  const plain = viewer.hudState();
  assert.equal(plain.debug, undefined);
  assert.equal(plain.inventory, undefined);
  assert.equal(plain.facing, 'north');
  assert.equal(plain.skyBrightness, 1);
  assert.deepEqual(plain.light, { known: true, block: 4, sky: 15, eff: 15, biome: 'plains' });
  assert.equal(plain.eyes, true);
  assert.equal(plain.viewDistance, 6);

  const full = viewer.hudState({ debug: true, inventory: true });
  assert.deepEqual(full.inventory.map(entry => entry.slot), [10, 36, 45]);
  assert.deepEqual(full.inventory[0], { slot: 10, name: 'cobblestone', count: 64 });
});

test('night keeps block light but drops sky light: effective light = max(block, sky * brightness)', () => {
  const viewer = new BrowserViewer({ token: 't', log: () => {} });
  const bot = fakeBot({ time: { timeOfDay: 18000, day: 3 } });
  viewer.attach(bot);
  const state = viewer.hudState();
  assert.equal(state.skyBrightness, 0);
  assert.equal(state.light.eff, 4);        // only the block light remains
});

test('light is "unknown" until the server has sent some, and resets on a new connection', () => {
  const viewer = new BrowserViewer({ token: 't', log: () => {} });
  const dark = { name: 'air', light: 0, skyLight: 0, biome: { name: 'plains' } };
  const bot = fakeBot({ blockAt: () => dark });
  viewer.attach(bot);
  assert.equal(viewer.hudState().light.known, false);
  dark.skyLight = 12;
  assert.equal(viewer.hudState().light.known, true);
  dark.skyLight = 0;
  assert.equal(viewer.hudState().light.known, true, 'a real dark cave stays known once light data has been seen');
  viewer.attach(fakeBot({ blockAt: () => ({ name: 'air', light: 0, skyLight: 0, biome: null }) }));
  assert.equal(viewer.hudState().light.known, false);
});

test('F3 data: chunk maths (negative coords), target block/entity, memory, bot-eyes perception', () => {
  const viewer = new BrowserViewer({ token: 't', log: () => {} });
  viewer.attach(fakeBot());
  const d = viewer.hudState({ debug: true }).debug;
  assert.deepEqual(d.blockPos, [-2, -63, 17]);
  assert.deepEqual(d.inChunk, [14, 1, 1]);          // -2 -> 14 in chunk -1; -63 -> 1 in section -4; 17 -> 1 in chunk 1
  assert.deepEqual(d.chunk, [-1, -4, 1]);
  assert.equal(d.version, '1.21.4');
  assert.equal(d.facingAxis, 'Towards negative Z');
  assert.ok(close(Math.abs(d.yawDegrees), 180) && d.pitchDegrees === 0);
  assert.equal(d.biome, 'plains');
  assert.equal(d.chunksLoaded, 3);
  assert.equal(d.entities, 2);
  assert.deepEqual(d.target, { name: 'grass_block', pos: [3, 63, 17], face: 1, properties: { snowy: 'false' } });
  assert.deepEqual(d.targetEntity, { name: 'zombie', distance: 3 });
  assert.equal(d.onGround, true);
  assert.ok(d.memoryMb.heap > 0 && d.node.startsWith('v'));
  assert.equal(d.perception.freeCenter, 80);
  assert.equal(d.perception.nearest, 3.1);
  assert.ok(d.perception.ageMs < 5000);
});

test('F3 data survives a bot with no targeting, light or perception support', () => {
  const viewer = new BrowserViewer({ token: 't', log: () => {} });
  const bot = fakeBot({ blockAtCursor: undefined, entityAtCursor: undefined, aiPerception: undefined, world: {}, blockAt: () => { throw new Error('chunk not loaded'); } });
  viewer.attach(bot);
  const state = viewer.hudState({ debug: true });
  assert.equal(state.debug.target, null);
  assert.equal(state.debug.targetEntity, null);
  assert.equal(state.debug.perception, null);
  assert.equal(state.debug.chunksLoaded, null);
  assert.equal(state.light.known, false);
});

// ------------------------------------------------------------------ routes + channel
async function startViewer(t, options = {}) {
  const viewer = new BrowserViewer({
    port: 3300 + Math.floor(Math.random() * 600),
    token: 'secret',
    log: () => {},
    controls: {
      busy: () => false,
      input: () => [],
      action: (action, payload) => ({ action, payload }),
      release: () => {},
      heartbeat: () => [],
      look: () => {},
      chat: () => {}
    },
    ...options
  });
  if (!viewer.start()) { t.skip('prismarine-viewer is not installed'); return null; }
  t.after(() => viewer.stop());
  await new Promise(resolve => setTimeout(resolve, 200));
  return viewer;
}
const get = (viewer, path, headers = { cookie: 'viewer_token=secret' }) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: viewer.server.address().port, path, headers }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  }).on('error', reject);
});

test('the viewer page loads the render hook before the bundle; scripts are served only with the token', async t => {
  const viewer = await startViewer(t);
  if (!viewer) return;
  const page = await get(viewer, '/');
  assert.equal(page.status, 200);
  const hookAt = page.body.indexOf('src="hook.js"');
  const bundleAt = page.body.indexOf('src="index.js"');
  assert.ok(hookAt > 0 && bundleAt > hookAt, 'hook.js must run first');
  for (const file of ['/hook.js', '/camera.js', '/controls.js', '/hud.js']) {
    assert.equal((await get(viewer, file)).status, 200, file);
    assert.equal((await get(viewer, file, {})).status, 401, `${file} without token`);
  }
  assert.equal((await get(viewer, '/', {})).status, 401);
  const wrapper = await get(viewer, '/watch');
  assert.ok(wrapper.body.includes('/camera.js') && wrapper.body.includes('id="eyes"'));
});

test('/api/hud only builds the expensive parts when asked', async t => {
  const viewer = await startViewer(t);
  if (!viewer) return;
  viewer.attach(fakeBot());
  const plain = JSON.parse((await get(viewer, '/api/hud')).body);
  assert.equal(plain.debug, undefined);
  const full = JSON.parse((await get(viewer, '/api/hud?debug=1&inv=1')).body);
  assert.equal(full.debug.version, '1.21.4');
  assert.equal(full.inventory.length, 3);
  assert.equal((await get(viewer, '/api/hud?debug=1', {})).status, 401);
});

test('bot eyes proxy: token required, fixed paths only, streams the C++ viewer, 404 when off, 502 when down', async t => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/stream') { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' }); res.end('--frame\r\nEYES\r\n'); }
    else if (req.url === '/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"fps":60}'); }
    else { res.writeHead(200); res.end('SECRET-' + req.url); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const viewer = await startViewer(t, { eyesUrl: `http://127.0.0.1:${upstream.address().port}` });
  if (!viewer) return;

  const stream = await get(viewer, '/eyes/stream');
  assert.equal(stream.status, 200);
  assert.match(stream.headers['content-type'], /multipart\/x-mixed-replace/);
  assert.match(stream.body, /EYES/);
  assert.equal(JSON.parse((await get(viewer, '/eyes/state')).body).fps, 60);
  assert.equal((await get(viewer, '/eyes/stream', {})).status, 401, 'the unauthenticated C++ viewer is not exposed through here');
  const other = await get(viewer, '/eyes/anything');
  assert.notEqual(other.body.includes('SECRET'), true, 'arbitrary upstream paths are not proxied');

  const off = await startViewer(t);
  assert.equal((await get(off, '/eyes/stream')).status, 404);

  upstream.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const down = await startViewer(t, { eyesUrl: 'http://127.0.0.1:1' });
  assert.equal((await get(down, '/eyes/stream')).status, 502);
});

test('control channel: pov draws the body, pose carries camera clearance, new actions and slot validation', async t => {
  if (!ioClient) return t.skip('socket.io-client is not installed');
  let busy = false;
  const calls = [];
  const viewer = await startViewer(t, {
    controls: {
      busy: () => busy,
      input: () => [],
      action: (action, payload) => { calls.push([action, payload]); return { action }; },
      release: () => {},
      heartbeat: () => [],
      look: () => {},
      chat: () => {}
    }
  });
  if (!viewer) return;
  const bot = fakeBot({
    world: { getColumns: () => [], raycast: (from, dir) => (dir.z > 0 ? { intersect: from.offset(0, 0, 1.25) } : null) }
  });
  viewer.attach(bot);
  const url = `http://127.0.0.1:${viewer.server.address().port}/control`;
  const socket = ioClient(url, { path: '/socket.io', transports: ['polling'], reconnection: false, extraHeaders: { cookie: 'viewer_token=secret' } });
  await new Promise(resolve => socket.on('connect', resolve));
  const poses = [];
  socket.on('pose', pose => poses.push(pose));

  // first person: pose has only the head direction, no raycasts
  bot.listeners.move();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(poses.at(-1).back, undefined);
  assert.equal(viewer.selfBody, 0);

  // third person (works even while an AI task is busy: it only changes the view)
  busy = true;
  socket.emit('pov', 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(viewer.selfBody, 1);
  bot.listeners.move();
  await new Promise(resolve => setTimeout(resolve, 100));
  const third = poses.at(-1);
  assert.ok(close(third.back, 1.25 - 0.25), `camera behind facing north hits the wall at +Z: ${third.back}`);
  assert.equal(third.front, 4);
  assert.equal(third.yaw, 0);

  socket.emit('pov', 7);                         // invalid modes are ignored
  socket.emit('pov', 'x');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(viewer.selfBody, 1);

  assert.equal((await emitAck(socket, 'action', { action: 'equip', slot: 10 })).ok, false, 'actions are still refused while busy');
  busy = false;
  assert.deepEqual(await emitAck(socket, 'action', { action: 'equip', slot: 10 }), { ok: true, result: { action: 'equip' } });
  assert.deepEqual(calls.at(-1), ['equip', { slot: 10, all: false }]);
  assert.equal((await emitAck(socket, 'action', { action: 'equip', slot: 99 })).ok, false);
  assert.equal((await emitAck(socket, 'action', { action: 'equip', slot: 1.5 })).ok, false);
  assert.equal((await emitAck(socket, 'action', { action: 'drop_slot', slot: 36, all: true })).ok, true);
  assert.deepEqual(calls.at(-1), ['drop_slot', { slot: 36, all: true }]);
  assert.equal((await emitAck(socket, 'action', { action: 'drop_slot', slot: 'a' })).ok, false);
  for (const action of ['attack', 'attack_release', 'use', 'use_release', 'pick', 'drop', 'swap_hand']) {
    assert.equal((await emitAck(socket, 'action', { action })).ok, true, action);
  }
  assert.equal((await emitAck(socket, 'action', { action: 'op' })).ok, false);

  socket.emit('pov', 0);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(viewer.selfBody, 0);

  socket.emit('pov', 2);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(viewer.selfBody, 1);
  socket.close();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(viewer.selfBody, 0, 'the body is removed when the browser that wanted it leaves');
});
