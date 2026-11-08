/* Play the bot from the browser, like the game:
 *   W A S D move, Space jump, Shift sneak, Ctrl sprint, mouse look (pointer lock)
 *   left click mine / attack (hold), right click place / use (hold), middle click pick block
 *   1-9 or mouse wheel hotbar, Q drop, F swap hands, E inventory, T / Enter chat
 *   F5 camera (first person / third person back / front), F3 debug screen, F1 hide HUD
 *   V show what the bot's own C++ eyes see, L lighting auto / full bright, [ ] field of view
 * Touch screens get a joystick, look pad and buttons. It also measures the real render fps of
 * the 3D view and the round-trip ping to the bot server. */
(function () {
  'use strict';
  var extra = (window.hudExtra = window.hudExtra || {});
  var defaults = { fps: 0, ping: 0, banner: '', bannerUntil: 0, playing: false, controllable: false, f3: false, hidden: false, inv: false, eyes: false, touch: false, mouse: { x: -1, y: -1 }, look: null, pose: null };
  Object.keys(defaults).forEach(function (key) { if (extra[key] === undefined) extra[key] = defaults[key]; });

  var frame = document.getElementById('world');
  var eyesImg = document.getElementById('eyes');
  var canvas = document.getElementById('hud');
  var wrap = document.getElementById('wrap');
  var chatBox = document.getElementById('chat-box');
  var chatInput = document.getElementById('chat-input');
  var socket = io('/control', { path: '/socket.io' });
  var held = {};
  var yaw = 0, pitch = 0, lookDirty = false, attackTimer = null, useTimer = null, scrollSlot = null, scrollAt = 0;
  var KEYS = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump', ShiftLeft: 'sneak', ShiftRight: 'sneak', ControlLeft: 'sprint', ControlRight: 'sprint' };

  function banner(text, ms) { extra.banner = text; extra.bannerUntil = Date.now() + (ms || 3000); }
  function state() { return (window.hudApi && window.hudApi.state()) || {}; }
  function act(action, extraFields) { socket.emit('action', Object.assign({ action: action }, extraFields || {})); }

  socket.on('connect', function () { extra.controllable = true; socket.emit('pov', extra.pov | 0); });
  socket.on('connect_error', function () { extra.controllable = false; });
  socket.on('disconnect', function () { extra.controllable = false; held = {}; setPlaying(false); });
  socket.on('denied', function (message) { banner(message, 4000); });
  socket.on('pose', function (pose) { extra.pose = pose; });

  // ---- real render fps: the hook counts the 3D view's own render calls ----
  var frames = 0, lastFrames = 0, last = performance.now();
  (function selfCount() { frames++; requestAnimationFrame(selfCount); })();
  setInterval(function () {
    var now = performance.now(), elapsed = (now - last) / 1000;
    var hook = null;
    try { hook = frame.contentWindow && frame.contentWindow.__vhook; } catch (e) { /* cross-origin */ }
    if (hook && typeof hook.frames === 'number' && !extra.eyes) {
      extra.fps = Math.round((hook.frames - lastFrames) / elapsed);
      lastFrames = hook.frames;
    } else {
      extra.fps = Math.round(frames / elapsed);          // this page's own rate (eyes view or no hook)
      if (hook) lastFrames = hook.frames;
    }
    frames = 0; last = now;
    var t0 = performance.now();
    socket.volatile.emit('ping-check', function () { extra.ping = Math.round(performance.now() - t0); });
  }, 1000);

  // ---- play mode ----
  function emitInput(input, pressed) {
    if (held[input] === pressed) return;
    held[input] = pressed;
    socket.emit('input', { input: input, pressed: pressed });
  }

  function stopTimers() {
    if (attackTimer) { clearInterval(attackTimer); attackTimer = null; act('attack_release'); }
    if (useTimer) { clearInterval(useTimer); useTimer = null; act('use_release'); }
  }

  function releaseAll() {
    Object.keys(held).forEach(function (input) { if (held[input]) emitInput(input, false); });
    stopTimers();
  }

  function setPlaying(on) {
    extra.playing = on;
    if (!on) { releaseAll(); extra.look = null; }
  }

  function startPlaying() {
    if (!extra.controllable) { banner('Control is not available (is the bot connected?)', 3000); return; }
    var s = state();
    yaw = s.yaw || 0; pitch = s.pitch || 0;
    extra.look = { yaw: yaw, pitch: pitch };
    setPlaying(true);
    extra.look = { yaw: yaw, pitch: pitch };
    var lock = document.body.requestPointerLock && document.body.requestPointerLock();
    if (lock && lock.catch) lock.catch(function () { banner('Mouse look needs pointer lock; keyboard still works.', 3000); });
  }

  function canvasPoint(event) {
    var rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (canvas.width / rect.width), y: (event.clientY - rect.top) * (canvas.height / rect.height) };
  }

  // ---- inventory ----
  function openInventory() {
    extra.inv = true;
    if (document.exitPointerLock) document.exitPointerLock();
    var wasPlaying = extra.playing;
    if (wasPlaying) setPlaying(false);
    extra.resumeAfterInv = wasPlaying && !extra.touch;
  }
  function closeInventory(resume) {
    extra.inv = false;
    if (resume && !extra.touch) startPlaying();
    if (extra.touch) extra.playing = true;
  }
  function inventoryClick(point, button, shift) {
    var slot = window.hudApi.invSlotAt(point.x, point.y);
    if (slot < 0) return;
    var item = (state().inventory || []).filter(function (entry) { return entry.slot === slot; })[0];
    if (!item) return;
    if (button === 2) act('drop_slot', { slot: slot, all: shift });
    else act('equip', { slot: slot });
  }

  wrap.addEventListener('mousedown', function (event) {
    if (extra.touch) return;
    extra.mouse = canvasPoint(event);
    if (extra.inv) { inventoryClick(extra.mouse, event.button, event.shiftKey); return; }
    if (!extra.playing) { if (event.target !== chatInput) startPlaying(); return; }
    if (event.button === 0) {
      act('attack');
      clearInterval(attackTimer);
      attackTimer = setInterval(function () { act('attack'); }, 300);
    } else if (event.button === 1) {
      event.preventDefault();
      act('pick');
    } else if (event.button === 2) {
      act('use');
      clearInterval(useTimer);
      useTimer = setInterval(function () { act('use'); }, 250);
    }
  });
  window.addEventListener('mouseup', function (event) {
    if (event.button === 0 && attackTimer) { clearInterval(attackTimer); attackTimer = null; act('attack_release'); }
    if (event.button === 2 && useTimer) { clearInterval(useTimer); useTimer = null; act('use_release'); }
  });
  window.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  window.addEventListener('mousemove', function (event) { if (extra.inv) extra.mouse = canvasPoint(event); });

  window.addEventListener('wheel', function (event) {
    if (!extra.playing || extra.inv) return;
    event.preventDefault();
    var now = Date.now();
    if (scrollSlot === null || now - scrollAt > 600) scrollSlot = state().slot || 0;
    scrollSlot = (scrollSlot + (event.deltaY > 0 ? 1 : -1) + 9) % 9;
    scrollAt = now;
    act('slot', { slot: scrollSlot });
  }, { passive: false });

  document.addEventListener('pointerlockchange', function () {
    if (!document.pointerLockElement && extra.playing && !extra.touch && chatBox.style.display !== 'block') setPlaying(false);
  });

  document.addEventListener('mousemove', function (event) {
    if (!extra.playing || extra.touch || document.pointerLockElement !== document.body) return;
    yaw -= event.movementX * 0.0022;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - event.movementY * 0.0022));
    extra.look = { yaw: yaw, pitch: pitch };      // the camera follows immediately; the server catches up
    lookDirty = true;
  });
  setInterval(function () {
    if (!lookDirty) return;
    lookDirty = false;
    socket.emit('look', { yaw: yaw, pitch: pitch });
  }, 33);
  setInterval(function () { if (extra.playing && Object.keys(held).some(function (k) { return held[k]; })) socket.emit('heartbeat'); }, 1000);

  // ---- chat ----
  function openChat() {
    chatBox.style.display = 'block';
    if (document.exitPointerLock) document.exitPointerLock();
    releaseAll();
    chatInput.value = '';
    chatInput.focus();
  }
  function closeChat(resume) {
    chatBox.style.display = 'none';
    chatInput.blur();
    if (resume && !extra.touch) startPlaying(); else if (!extra.touch) setPlaying(false);
  }
  chatInput.addEventListener('keydown', function (event) {
    event.stopPropagation();
    if (event.key === 'Enter') { var text = chatInput.value.trim(); if (text) socket.emit('chat', text); closeChat(true); }
    else if (event.key === 'Escape') closeChat(false);
  });

  // ---- view toggles (work whether or not you are playing) ----
  function togglePov() {
    var name = window.camApi ? window.camApi.cyclePov() : '';
    socket.emit('pov', extra.pov | 0);
    if (!extra.hooked) banner(name + ' (camera hook not active: reload the page)', 3500); else banner('Camera: ' + name, 2000);
    if (extra.eyes) banner('Camera: ' + name + ' (shown when you leave the bot-eyes view)', 3000);
  }
  function toggleEyes() {
    if (!state().eyes) { banner('Bot eyes are off: set view.enabled in settings.json and build cpp/bot_view', 4000); return; }
    extra.eyes = !extra.eyes;
    frame.style.display = extra.eyes ? 'none' : 'block';
    eyesImg.style.display = extra.eyes ? 'block' : 'none';
    eyesImg.src = extra.eyes ? '/eyes/stream?t=' + Date.now() : '';
    banner(extra.eyes ? 'Bot eyes: the C++ viewer the bot plays from' : 'Your view', 2500);
  }
  eyesImg.addEventListener('error', function () { if (extra.eyes) { banner('Bot eyes are not running (see cpp/README.md)', 4000); toggleEyes(); } });

  function viewKey(event) {
    switch (event.code) {
      case 'F3': extra.f3 = !extra.f3; return true;
      case 'F5': togglePov(); return true;
      case 'F1': extra.hidden = !extra.hidden; return true;
      case 'KeyV': toggleEyes(); return true;
      case 'KeyL': banner('Lighting: ' + (window.camApi.cycleLighting() === 'auto' ? 'real light levels' : 'full bright'), 2000); return true;
      case 'BracketLeft': banner('FOV ' + window.camApi.setFov((extra.fov || 75) - 5), 1500); return true;
      case 'BracketRight': banner('FOV ' + window.camApi.setFov((extra.fov || 75) + 5), 1500); return true;
      default: return false;
    }
  }

  window.addEventListener('keydown', function (event) {
    if (chatBox.style.display === 'block') return;
    if (event.repeat) { if (event.code === 'F3' || event.code === 'F5' || event.code === 'F1') event.preventDefault(); return; }
    if (viewKey(event)) { event.preventDefault(); return; }
    if (event.code === 'KeyE' && (extra.playing || extra.inv)) {
      event.preventDefault();
      if (extra.inv) closeInventory(true); else openInventory();
      return;
    }
    if (event.code === 'Escape' && extra.inv) { closeInventory(false); return; }
    if (extra.inv) {
      if (event.code === 'KeyQ') {
        var slot = window.hudApi.invSlotAt(extra.mouse.x, extra.mouse.y);
        if (slot >= 0) act('drop_slot', { slot: slot, all: event.shiftKey });
        event.preventDefault();
      } else if (/^Digit[1-9]$/.test(event.code)) {
        act('slot', { slot: Number(event.code.slice(5)) - 1 });
      }
      return;
    }
    if (!extra.playing) return;
    if (KEYS[event.code]) { emitInput(KEYS[event.code], true); event.preventDefault(); return; }
    if (/^Digit[1-9]$/.test(event.code)) { act('slot', { slot: Number(event.code.slice(5)) - 1 }); event.preventDefault(); return; }
    if (event.code === 'KeyQ') act('drop');
    else if (event.code === 'KeyF') act('swap_hand');
    else if (event.code === 'KeyT' || event.code === 'Enter') { event.preventDefault(); openChat(); }
  });
  window.addEventListener('keyup', function (event) { if (KEYS[event.code]) emitInput(KEYS[event.code], false); });
  window.addEventListener('blur', function () { releaseAll(); });

  // ---- touch: joystick, look pad, buttons ----
  function setupTouch() {
    extra.touch = true;
    var style = document.createElement('style');
    style.textContent = '#touch{position:absolute;inset:0;pointer-events:none;z-index:5}' +
      '#touch .pad{position:absolute;pointer-events:auto;touch-action:none}' +
      '#joy{left:14px;bottom:78px;width:132px;height:132px;border-radius:50%;background:rgba(255,255,255,.12);border:2px solid rgba(255,255,255,.4)}' +
      '#knob{position:absolute;left:46px;top:46px;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.5)}' +
      '#lookpad{right:0;top:0;width:55%;height:100%}' +
      '.tb{position:absolute;pointer-events:auto;touch-action:none;width:54px;height:54px;border-radius:50%;background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.5);color:#fff;font:600 12px system-ui,sans-serif;display:flex;align-items:center;justify-content:center}' +
      '.tb.on{background:rgba(255,255,255,.45)}';
    document.head.appendChild(style);
    var layer = document.createElement('div');
    layer.id = 'touch';
    layer.innerHTML = '<div class="pad" id="lookpad"></div><div class="pad" id="joy"><div id="knob"></div></div>';
    wrap.appendChild(layer);

    var buttons = [
      ['Jump', 'right:14px;bottom:78px', 'hold', function (on) { emitInput('jump', on); }],
      ['Sneak', 'right:78px;bottom:78px', 'toggle', function (on) { emitInput('sneak', on); }],
      ['Hit', 'right:14px;bottom:142px', 'hold', function (on) { stopTimers(); if (on) { act('attack'); attackTimer = setInterval(function () { act('attack'); }, 300); } }],
      ['Use', 'right:78px;bottom:142px', 'hold', function (on) { stopTimers(); if (on) { act('use'); useTimer = setInterval(function () { act('use'); }, 250); } }],
      ['Inv', 'right:14px;top:60px', 'tap', function () { if (extra.inv) closeInventory(false); else openInventory(); }],
      ['Cam', 'right:78px;top:60px', 'tap', function () { togglePov(); }],
      ['F3', 'right:142px;top:60px', 'tap', function () { extra.f3 = !extra.f3; }],
      ['Chat', 'right:206px;top:60px', 'tap', function () { openChat(); }]
    ];
    buttons.forEach(function (def) {
      var b = document.createElement('div');
      b.className = 'tb'; b.textContent = def[0]; b.style.cssText = def[1];
      var on = false;
      b.addEventListener('touchstart', function (e) {
        e.preventDefault();
        if (def[2] === 'toggle') { on = !on; b.classList.toggle('on', on); def[3](on); }
        else { on = true; b.classList.add('on'); def[3](true); if (def[2] === 'tap') { on = false; setTimeout(function () { b.classList.remove('on'); }, 120); } }
      }, { passive: false });
      var end = function (e) { e.preventDefault(); if (def[2] === 'hold' && on) { on = false; b.classList.remove('on'); def[3](false); } };
      b.addEventListener('touchend', end, { passive: false });
      b.addEventListener('touchcancel', end, { passive: false });
      layer.appendChild(b);
    });

    // joystick -> forward/back/left/right, pushed all the way forward sprints
    var joy = document.getElementById('joy'), knob = document.getElementById('knob'), joyId = null;
    function joyMove(touch) {
      var rect = joy.getBoundingClientRect(), r = rect.width / 2;
      var dx = (touch.clientX - rect.left - r) / r, dy = (touch.clientY - rect.top - r) / r;
      var len = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(1, len);
      knob.style.transform = 'translate(' + (dx / len * k * r * 0.6) + 'px,' + (dy / len * k * r * 0.6) + 'px)';
      emitInput('forward', dy < -0.3); emitInput('back', dy > 0.3);
      emitInput('left', dx < -0.3); emitInput('right', dx > 0.3);
      emitInput('sprint', dy < -0.9);
    }
    function joyEnd() { joyId = null; knob.style.transform = ''; ['forward', 'back', 'left', 'right', 'sprint'].forEach(function (i) { emitInput(i, false); }); }
    joy.addEventListener('touchstart', function (e) { e.preventDefault(); var t = e.changedTouches[0]; joyId = t.identifier; joyMove(t); }, { passive: false });
    joy.addEventListener('touchmove', function (e) { e.preventDefault(); for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === joyId) joyMove(e.changedTouches[i]); }, { passive: false });
    joy.addEventListener('touchend', function (e) { e.preventDefault(); joyEnd(); }, { passive: false });
    joy.addEventListener('touchcancel', function (e) { e.preventDefault(); joyEnd(); }, { passive: false });

    // drag anywhere on the right side to look; tap the hotbar / inventory slots directly
    var pad = document.getElementById('lookpad'), lookId = null, lastX = 0, lastY = 0;
    pad.addEventListener('touchstart', function (e) {
      e.preventDefault();
      var t = e.changedTouches[0], point = canvasPoint(t);
      if (extra.inv) { inventoryClick(point, 0, false); return; }
      var slot = window.hudApi.hotbarSlotAt(point.x, point.y);
      if (slot >= 0) { act('slot', { slot: slot }); return; }
      lookId = t.identifier; lastX = t.clientX; lastY = t.clientY;
      if (!extra.playing) { var s = state(); yaw = s.yaw || 0; pitch = s.pitch || 0; extra.look = { yaw: yaw, pitch: pitch }; setPlaying(true); }
    }, { passive: false });
    pad.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== lookId) continue;
        yaw -= (t.clientX - lastX) * 0.006;
        pitch = Math.max(-1.55, Math.min(1.55, pitch - (t.clientY - lastY) * 0.006));
        lastX = t.clientX; lastY = t.clientY;
        extra.look = { yaw: yaw, pitch: pitch }; lookDirty = true;
      }
    }, { passive: false });
    pad.addEventListener('touchend', function () { lookId = null; });
    pad.addEventListener('touchcancel', function () { lookId = null; });
    extra.playing = true;      // no pointer lock on touch: controls are live as soon as the page loads
    var s0 = state(); yaw = s0.yaw || 0; pitch = s0.pitch || 0;
    banner('Touch controls: joystick to move, drag to look, tap the hotbar to select', 5000);
  }
  if ((window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || /[?&]touch=1/.test(location.search)) setupTouch();
})();
