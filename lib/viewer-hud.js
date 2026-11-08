/* Draws the Minecraft HUD (hotbar, hearts, hunger, XP, crosshair, chat, coordinates)
 * over the bot's first-person view, using the game's own sprites and bitmap font.
 * Runs in the browser; data comes from /api/hud. */
(function () {
  'use strict';
  var canvas = document.getElementById('hud');
  var ctx = canvas.getContext('2d');
  var state = { connected: false };
  var extra = (window.hudExtra = window.hudExtra || {});
  var layout = { s: 1, W: 0, H: 0, barX: 0, barY: 0, inv: null };
  window.hudApi = {
    state: function () { return state; },
    glyph: function (c) { return glyph(c); },
    layout: function () { return layout; },
    // Which inventory slot (0-45) is under a point given in canvas pixels, or -1.
    invSlotAt: function (x, y) { return invSlotAt(x, y); },
    // Which hotbar slot (0-8) is under a point given in canvas pixels, or -1.
    hotbarSlotAt: function (x, y) {
      var s = layout.s;
      if (y < layout.barY || y > layout.barY + 22 * s || x < layout.barX || x > layout.barX + 182 * s) return -1;
      return Math.max(0, Math.min(8, Math.floor((x - layout.barX - 1 * s) / (20 * s))));
    }
  };
  var images = {};
  var textureBase = '/textures/1.21.4/';

  function img(path) {
    var entry = images[path];
    if (!entry) {
      entry = images[path] = { image: new Image(), ok: false, failed: false };
      entry.image.onload = function () { entry.ok = true; };
      entry.image.onerror = function () { entry.failed = true; };
      entry.image.src = textureBase + path;
    }
    return entry.ok ? entry.image : null;
  }

  function sprite(name) { return img('gui/sprites/hud/' + name + '.png'); }

  // Item icon: items/ first, then block textures (flat, not the 3D cube the game draws).
  function itemImage(name) {
    var tries = ['items/' + name + '.png', 'blocks/' + name + '.png', 'blocks/' + name + '_side.png', 'blocks/' + name + '_top.png', 'blocks/' + name + '_front.png'];
    for (var i = 0; i < tries.length; i++) {
      var entry = images[tries[i]];
      if (!entry) { img(tries[i]); return null; }   // start loading, draw next frame
      if (entry.ok) return entry.image;
      if (!entry.failed) return null;                // still loading
      // failed: fall through to the next candidate
    }
    return null;
  }

  // ---- Minecraft bitmap font (font/ascii.png: 16x16 grid of 8x8 glyphs) ----
  var glyphs = {};
  var fontReady = false;
  var fontImage = new Image();
  fontImage.onload = function () { fontReady = true; };
  fontImage.src = textureBase + 'font/ascii.png';

  function glyph(ch) {
    if (glyphs[ch]) return glyphs[ch];
    // Until the font image has loaded the pixels are blank: measure with a typical width
    // and do NOT cache, or these characters would stay invisible forever.
    if (!fontReady) return { canvas: document.createElement('canvas'), width: ch === ' ' ? 3 : 5 };
    var code = ch.charCodeAt(0);
    if (code > 255) code = 63;
    var gx = (code % 16) * 8, gy = Math.floor(code / 16) * 8;
    var c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    var g = c.getContext('2d');
    g.drawImage(fontImage, gx, gy, 8, 8, 0, 0, 8, 8);
    var data = g.getImageData(0, 0, 8, 8).data, width = 0;
    for (var x = 0; x < 8; x++) for (var y = 0; y < 8; y++) if (data[(y * 8 + x) * 4 + 3] > 0) width = Math.max(width, x + 1);
    return (glyphs[ch] = { canvas: c, width: ch === ' ' ? 3 : width });
  }

  var tinted = {};
  function tintedGlyph(ch, color) {
    var key = ch + color;
    if (tinted[key]) return tinted[key];
    var base = glyph(ch);
    var c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    var g = c.getContext('2d');
    g.drawImage(base.canvas, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, 8, 8);
    return (tinted[key] = c);
  }

  function textWidth(text) {
    var w = 0;
    for (var i = 0; i < text.length; i++) w += glyph(text[i]).width + 1;
    return Math.max(0, w - 1);
  }

  function drawText(text, x, y, s, color, shadow) {
    if (!fontReady) return;
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i], g = glyph(ch);
      if (shadow !== false) ctx.drawImage(tintedGlyph(ch, '#3f3f3f'), cx + s, y + s, 8 * s, 8 * s);
      ctx.drawImage(tintedGlyph(ch, color || '#ffffff'), cx, y, 8 * s, 8 * s);
      cx += (g.width + 1) * s;
    }
  }

  function draw(name, x, y, w, h, s) {
    var image = typeof name === 'string' ? sprite(name) : name;
    if (image) ctx.drawImage(image, Math.round(x), Math.round(y), w * s, h * s);
  }


  function pretty(name) {
    return String(name || '').replace(/^minecraft:/, '').replace(/_/g, ' ').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }
  function num(n, d) { return Number(n || 0).toFixed(d === undefined ? 2 : d); }

  // Slot positions inside the 176x166 inventory texture (item top-left corners).
  var INV_SLOTS = (function () {
    var m = {}, i, r, c;
    for (i = 0; i < 4; i++) m[5 + i] = [8, 8 + i * 18];                       // head, chest, legs, feet
    m[45] = [77, 62];                                                         // off hand
    for (i = 0; i < 4; i++) m[1 + i] = [98 + (i % 2) * 18, 18 + Math.floor(i / 2) * 18];   // 2x2 crafting
    m[0] = [154, 28];                                                         // crafting result
    for (r = 0; r < 3; r++) for (c = 0; c < 9; c++) m[9 + r * 9 + c] = [8 + c * 18, 84 + r * 18];
    for (c = 0; c < 9; c++) m[36 + c] = [8 + c * 18, 142];
    return m;
  })();

  function invGeometry(W, H, s) {
    var is = Math.max(1, Math.min(s, Math.floor(W / 180), Math.floor(H / 172)));
    return { is: is, x: Math.round((W - 176 * is) / 2), y: Math.round((H - 166 * is) / 2) };
  }

  function invSlotAt(x, y) {
    var g = layout.inv;
    if (!g) return -1;
    for (var slot in INV_SLOTS) {
      var sx = g.x + INV_SLOTS[slot][0] * g.is, sy = g.y + INV_SLOTS[slot][1] * g.is;
      if (x >= sx && x < sx + 16 * g.is && y >= sy && y < sy + 16 * g.is) return Number(slot);
    }
    return -1;
  }

  function drawInventory(W, H, s) {
    var g = invGeometry(W, H, s), is = g.is;
    layout.inv = g;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);
    var bg = img('gui/container/inventory.png');
    if (bg) ctx.drawImage(bg, 0, 0, 176, 166, g.x, g.y, 176 * is, 166 * is);
    else { ctx.fillStyle = '#c6c6c6'; ctx.fillRect(g.x, g.y, 176 * is, 166 * is); }
    drawText('Crafting', g.x + 97 * is, g.y + 8 * is, is, '#404040', false);
    drawText('Inventory', g.x + 8 * is, g.y + 72 * is, is, '#404040', false);

    var items = {}, list = state.inventory || [];
    for (var i = 0; i < list.length; i++) items[list[i].slot] = list[i];
    var mouse = extra.mouse || { x: -1, y: -1 }, hover = invSlotAt(mouse.x, mouse.y), hovered = null;
    for (var slot in INV_SLOTS) {
      var px = g.x + INV_SLOTS[slot][0] * is, py = g.y + INV_SLOTS[slot][1] * is, item = items[slot];
      if (item) {
        var icon = itemImage(item.name);
        if (icon) ctx.drawImage(icon, px, py, 16 * is, 16 * is);
        else drawText(item.name.slice(0, 3), px, py + 4 * is, is, '#dddddd');
        if (item.count > 1) { var label = String(item.count); drawText(label, px + (17 - textWidth(label)) * is, py + 9 * is, is, '#ffffff'); }
      }
      if (Number(slot) === 36 + (state.slot || 0)) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(1, is); ctx.strokeRect(px - is * 0.5, py - is * 0.5, 17 * is, 17 * is); }
      if (Number(slot) === hover) { ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(px, py, 16 * is, 16 * is); hovered = item; }
    }
    if (hovered) {
      var tip = pretty(hovered.name) + (hovered.count > 1 ? ' x' + hovered.count : '');
      var tw = textWidth(tip) * is, tx = Math.min(mouse.x + 12 * is, W - tw - 10 * is), ty = Math.max(0, mouse.y - 14 * is);
      ctx.fillStyle = 'rgba(16,0,16,0.94)'; ctx.fillRect(tx - 3 * is, ty - 3 * is, tw + 6 * is, 12 * is);
      ctx.strokeStyle = '#2d0a63'; ctx.lineWidth = Math.max(1, is); ctx.strokeRect(tx - 3 * is, ty - 3 * is, tw + 6 * is, 12 * is);
      drawText(tip, tx, ty, is, '#ffffff');
    }
    var help = 'Click: hold   Right-click / Q: drop one   Shift+Q: drop stack   E / Esc: close';
    drawText(help, Math.round(W / 2 - textWidth(help) * is / 2), g.y + 170 * is, is, '#cccccc');
  }

  // Vanilla-style F3 screen: left and right columns on translucent strips.
  function drawColumn(lines, x, y, s, right, W) {
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '') continue;
      var tw = textWidth(line) * s, lx = right ? W - tw - 3 * s : x;
      ctx.fillStyle = 'rgba(80,80,80,0.56)';
      ctx.fillRect(lx - s, y + i * 10 * s - s, tw + 2 * s, 10 * s);
      drawText(line, lx, y + i * 10 * s, s, '#e0e0e0');
    }
  }

  function f3Lines(W, H, s) {
    var d = state.debug || {}, p = state.pos || { x: 0, y: 0, z: 0 }, l = state.light || {};
    var left = [
      'Minecraft ' + (d.version || '?') + ' (' + (d.brand || 'Mineflayer') + ')',
      (extra.fps || 0) + ' fps  (browser, ' + (extra.hooked ? 'hooked' : 'plain') + ')',
      'Bot server ping: ' + (extra.ping || 0) + ' ms' + (d.ping !== null && d.ping !== undefined ? '   MC ping: ' + d.ping + ' ms' : ''),
      (d.chunksLoaded === null || d.chunksLoaded === undefined ? '?' : d.chunksLoaded) + ' chunks loaded, ' + (d.entities || 0) + ' entities',
      '',
      'XYZ: ' + num(p.x, 3) + ' / ' + num(p.y, 5) + ' / ' + num(p.z, 3),
      'Block: ' + (d.blockPos || [0, 0, 0]).join(' '),
      'Chunk: ' + (d.inChunk || [0, 0, 0]).join(' ') + ' in ' + (d.chunk || [0, 0, 0]).join(' '),
      'Facing: ' + (state.facing || '?') + ' (' + (d.facingAxis || '') + ') (' + num(d.yawDegrees, 1) + ' / ' + num(d.pitchDegrees, 1) + ')',
      l.known ? 'Light: ' + l.eff + ' (' + l.sky + ' sky, ' + l.block + ' block)' : 'Light: no light data from this server (using time of day)',
      'Sky: ' + Math.round((state.skyBrightness === undefined ? 1 : state.skyBrightness) * 100) + '%   Lighting: ' + (extra.lighting || 'auto'),
      'Biome: ' + (d.biome ? 'minecraft:' + String(d.biome).replace(/^minecraft:/, '') : '?'),
      'Time: ' + (state.dayTime === null || state.dayTime === undefined ? '?' : state.dayTime) + (d.day !== null && d.day !== undefined ? '   Day: ' + d.day : '') + (d.raining ? '   Raining' : ''),
      'Dimension: ' + (state.dimension || '?') + '   Mode: ' + (state.gameMode || '?'),
      'Health: ' + num(state.health, 1) + '   Food: ' + state.food + (d.saturation !== null && d.saturation !== undefined ? '   Sat: ' + num(d.saturation, 1) : '') + (d.air !== null && d.air !== undefined && d.air < 300 ? '   Air: ' + d.air : ''),
      'Velocity: ' + (d.velocity || [0, 0, 0]).map(function (v) { return num(v, 2); }).join(' ') + (d.onGround ? '  (on ground)' : '  (airborne)'),
      '',
      'Camera: ' + (window.camApi ? window.camApi.povName() : '?') + '  FOV ' + (extra.fov || 75) + '  [F5 / [ ]]'
    ];
    var right = [
      'Node ' + (d.node || '?') + '  Mineflayer bot',
      'Mem: ' + (d.memoryMb ? d.memoryMb.heap + ' MB heap / ' + d.memoryMb.rss + ' MB rss' : '?'),
      'Display: ' + W + 'x' + H + '  (GUI scale ' + s + ')',
      'Control: ' + (extra.playing ? 'you (browser)' : (extra.controllable ? 'free (click to play)' : 'not available')),
      '',
      d.target ? 'Targeted Block: ' + d.target.pos.join(', ') : 'Targeted Block: none',
      d.target ? 'minecraft:' + d.target.name : ''
    ];
    if (d.target && d.target.properties) {
      Object.keys(d.target.properties).slice(0, 6).forEach(function (k) { right.push(k + ': ' + d.target.properties[k]); });
    }
    right.push(d.targetEntity ? 'Targeted Entity: ' + d.targetEntity.name + ' (' + d.targetEntity.distance + ' m)' : 'Targeted Entity: none');
    if (d.perception) {
      var q = d.perception;
      right.push('', 'Bot eyes (C++ viewer)', 'free C/L/R: ' + q.freeCenter + ' / ' + q.freeLeft + ' / ' + q.freeRight + ' %',
        'clear ahead: ' + num(q.forwardClear, 1) + ' m  nearest: ' + num(q.nearest, 1) + ' m', 'eye fps: ' + q.fps + (q.ageMs > 2000 ? '  (stale)' : ''));
    } else if (state.eyes) {
      right.push('', 'Bot eyes: waiting for the C++ viewer');
    }
    return { left: left, right: right };
  }

  function drawBanner(W, s) {
    var note = '';
    if (extra.bannerUntil > Date.now()) note = extra.banner;
    else if (extra.controllable && !extra.playing && !extra.inv && !extra.hidden) note = 'Click to play  (WASD, mouse, E inventory, F5 camera, F3 debug, T chat, Esc releases)';
    if (note) drawText(note, Math.round(W / 2 - textWidth(note) * s / 2), (extra.eyes ? 14 : 14) * s, s, '#ffffff');
  }

  function frame() {
    var dpr = window.devicePixelRatio || 1;
    var W = Math.floor(canvas.clientWidth * dpr), H = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    // Minecraft's GUI scale: largest integer where a 320x240 area still fits.
    var s = Math.max(1, Math.min(Math.floor(W / 320), Math.floor(H / 240)));
    layout.s = s; layout.W = W; layout.H = H;
    layout.inv = null;

    if (!state.connected) {
      drawText('Waiting for the bot to join...', 8 * s, 8 * s, s, '#ffffff');
      return;
    }

    if (extra.hidden) {                       // F1: hide the HUD like the game does
      drawBanner(W, s);
      return;
    }

    var barX = Math.round(W / 2 - 91 * s), barY = H - 22 * s;
    layout.barX = barX; layout.barY = barY;
    draw('hotbar', barX, barY, 182, 22, s);

    for (var i = 0; i < 9; i++) {
      var slot = state.hotbar[i];
      if (!slot) continue;
      var ix = barX + (3 + i * 20) * s, iy = barY + 3 * s;
      var icon = itemImage(slot.name);
      if (icon) ctx.drawImage(icon, ix, iy, 16 * s, 16 * s);
      else drawText(slot.name.slice(0, 3), ix, iy + 4 * s, s, '#dddddd');
      if (slot.count > 1) {
        var label = String(slot.count);
        drawText(label, ix + (17 - textWidth(label)) * s, iy + 9 * s, s, '#ffffff');
      }
    }
    draw('hotbar_selection', barX + (-1 + state.slot * 20) * s, barY - 1 * s, 24, 23, s);

    var rowY = H - 39 * s;
    var hearts = Math.ceil((state.maxHealth || 20) / 2);
    for (var h = 0; h < hearts; h++) {
      var hx = barX + h * 8 * s, hv = state.health - h * 2;
      draw('heart/container', hx, rowY, 9, 9, s);
      if (hv >= 2) draw('heart/full', hx, rowY, 9, 9, s);
      else if (hv >= 1) draw('heart/half', hx, rowY, 9, 9, s);
    }
    var hungry = state.hunger ? '_hunger' : '';
    for (var f = 0; f < 10; f++) {
      var fx = barX + (182 - 9 - f * 8) * s, fv = state.food - f * 2;
      draw('food_empty' + hungry, fx, rowY, 9, 9, s);
      if (fv >= 2) draw('food_full' + hungry, fx, rowY, 9, 9, s);
      else if (fv >= 1) draw('food_half' + hungry, fx, rowY, 9, 9, s);
    }

    var xpY = H - 29 * s;
    draw('experience_bar_background', barX, xpY, 182, 5, s);
    var progress = Math.max(0, Math.min(1, state.xpProgress || 0));
    var xpImage = sprite('experience_bar_progress');
    if (xpImage && progress > 0) ctx.drawImage(xpImage, 0, 0, Math.ceil(182 * progress), 5, barX, xpY, Math.ceil(182 * progress) * s, 5 * s);
    if (state.xpLevel > 0) {
      var level = String(state.xpLevel);
      drawText(level, Math.round(W / 2 - textWidth(level) * s / 2), H - 35 * s, s, '#80ff20');
    }

    // Crosshair (inverted so it shows on any background, like the game).
    var cross = sprite('crosshair');
    if (cross) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.drawImage(cross, Math.round(W / 2 - 7.5 * s), Math.round(H / 2 - 7.5 * s), 15 * s, 15 * s);
      ctx.restore();
    }

    // Top left: the always-on coordinate readout, or the full F3 screen.
    var p = state.pos || { x: 0, y: 0, z: 0 };
    if (extra.f3) {
      var cols = f3Lines(W, H, s);
      drawColumn(cols.left, 2 * s, 2 * s, s, false, W);
      drawColumn(cols.right, 0, 2 * s, s, true, W);
    } else {
      var lines = [
        'XYZ: ' + p.x.toFixed(2) + ' / ' + p.y.toFixed(2) + ' / ' + p.z.toFixed(2),
        'Facing: ' + (state.facing || '?') + '  ' + (state.dimension || ''),
        'Mode: ' + (state.gameMode || '?') + '  Time: ' + (state.dayTime == null ? '?' : state.dayTime) + '  F3: debug'
      ];
      for (var l = 0; l < lines.length; l++) drawText(lines[l], 2 * s, (2 + l * 10) * s, s, '#e0e0e0');
      var perf = (extra.fps || 0) + ' fps  ' + (extra.ping || 0) + ' ms';
      drawText(perf, W - (textWidth(perf) + 3) * s, 2 * s, s, extra.fps >= 55 ? '#80ff20' : extra.fps >= 30 ? '#ffff55' : '#ff5555');
    }
    if (extra.eyes) drawText('Bot eyes (C++ viewer)  V: back to your view', Math.round(W / 2 - textWidth('Bot eyes (C++ viewer)  V: back to your view') * s / 2), 4 * s, s, '#ffff55');
    drawBanner(W, s);

    // Chat, bottom left above the hotbar rows; messages fade after about 10 s.
    var now = Date.now();
    var shown = (state.chat || []).filter(function (m) { return now - m.t < 10000; }).slice(-8);
    var base = H - 48 * s;
    for (var c = 0; c < shown.length; c++) {
      var age = now - shown[c].t, alpha = age > 8000 ? 1 - (age - 8000) / 2000 : 1;
      var y = base - (shown.length - c) * 9 * s;
      ctx.fillStyle = 'rgba(0,0,0,' + (0.4 * alpha) + ')';
      ctx.fillRect(2 * s, y - s, (textWidth(shown[c].text) + 2) * s, 9 * s);
      ctx.globalAlpha = alpha;
      drawText(shown[c].text, 3 * s, y, s, '#ffffff');
      ctx.globalAlpha = 1;
    }

    if (extra.inv) drawInventory(W, H, s);
  }

  function poll() {
    var query = (extra.f3 ? 'debug=1&' : '') + (extra.inv ? 'inv=1' : '');
    fetch('/api/hud' + (query ? '?' + query : ''), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.textureVersion && textureBase.indexOf(data.textureVersion) === -1) {
          textureBase = '/textures/' + data.textureVersion + '/';
          images = {}; glyphs = {}; tinted = {}; fontReady = false;
          fontImage = new Image();
          fontImage.onload = function () { fontReady = true; };
          fontImage.src = textureBase + 'font/ascii.png';
        }
        state = data;
      })
      .catch(function () { state = { connected: false }; });
  }

  setInterval(poll, 250);
  poll();
  (function loop() { frame(); requestAnimationFrame(loop); })();
})();
