/* Draws the Minecraft HUD (hotbar, hearts, hunger, XP, crosshair, chat, coordinates)
 * over the bot's first-person view, using the game's own sprites and bitmap font.
 * Runs in the browser; data comes from /api/hud. */
(function () {
  'use strict';
  var canvas = document.getElementById('hud');
  var ctx = canvas.getContext('2d');
  var state = { connected: false };
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

  function frame() {
    var dpr = window.devicePixelRatio || 1;
    var W = Math.floor(canvas.clientWidth * dpr), H = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    // Minecraft's GUI scale: largest integer where a 320x240 area still fits.
    var s = Math.max(1, Math.min(Math.floor(W / 320), Math.floor(H / 240)));

    if (!state.connected) {
      drawText('Waiting for the bot to join...', 8 * s, 8 * s, s, '#ffffff');
      return;
    }

    var barX = Math.round(W / 2 - 91 * s), barY = H - 22 * s;
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

    // F3-style readout, top left.
    var p = state.pos || { x: 0, y: 0, z: 0 };
    var lines = [
      'XYZ: ' + p.x.toFixed(2) + ' / ' + p.y.toFixed(2) + ' / ' + p.z.toFixed(2),
      'Facing: ' + (state.facing || '?') + '  ' + (state.dimension || ''),
      'Mode: ' + (state.gameMode || '?') + '  Time: ' + (state.dayTime == null ? '?' : state.dayTime)
    ];
    for (var l = 0; l < lines.length; l++) drawText(lines[l], 2 * s, (2 + l * 10) * s, s, '#e0e0e0');

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
  }

  function poll() {
    fetch('/api/hud', { credentials: 'same-origin', cache: 'no-store' })
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
