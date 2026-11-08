/* Play the bot from the browser: WASD, mouse look (pointer lock), jump/sneak/sprint,
 * 1-9 hotbar, click to attack/use, Q drop, F swap hand, T chat. Also measures the real
 * render fps of the 3D view and the round-trip ping to the bot server. */
(function () {
  'use strict';
  var extra = (window.hudExtra = { fps: 0, ping: 0, banner: '', bannerUntil: 0, playing: false, controllable: false });
  var frame = document.getElementById('world');
  var chatBox = document.getElementById('chat-box');
  var chatInput = document.getElementById('chat-input');
  var socket = io('/control', { path: '/socket.io' });
  var held = {};
  var yaw = 0, pitch = 0, lookDirty = false, attackTimer = null;
  var KEYS = { KeyW: 'forward', KeyS: 'back', KeyA: 'left', KeyD: 'right', Space: 'jump', ShiftLeft: 'sneak', ShiftRight: 'sneak', ControlLeft: 'sprint', ControlRight: 'sprint' };

  function banner(text, ms) { extra.banner = text; extra.bannerUntil = Date.now() + (ms || 3000); }
  function state() { return (window.hudApi && window.hudApi.state()) || {}; }

  socket.on('connect', function () { extra.controllable = true; });
  socket.on('connect_error', function () { extra.controllable = false; });
  socket.on('disconnect', function () { extra.controllable = false; held = {}; setPlaying(false); });
  socket.on('denied', function (message) { banner(message, 4000); });

  // ---- real render fps: count the 3D view's own animation frames ----
  var frames = 0, last = performance.now();
  function hookRaf() {
    try {
      var w = frame.contentWindow, original = w.requestAnimationFrame.bind(w);
      if (w.__fpsHooked) return;
      w.__fpsHooked = true;
      w.requestAnimationFrame = function (cb) { frames++; return original(cb); };
    } catch (e) { /* cross-origin: fall back to this page's own rate */ }
  }
  frame.addEventListener('load', function () { hookRaf(); setTimeout(hookRaf, 1000); });
  (function selfCount() { if (!frame.contentWindow || !frame.contentWindow.__fpsHooked) frames++; requestAnimationFrame(selfCount); })();
  setInterval(function () {
    var now = performance.now();
    extra.fps = Math.round(frames * 1000 / (now - last));
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

  function releaseAll() {
    Object.keys(held).forEach(function (input) { if (held[input]) emitInput(input, false); });
    clearInterval(attackTimer); attackTimer = null;
  }

  function setPlaying(on) {
    extra.playing = on;
    if (!on) releaseAll();
  }

  function startPlaying() {
    if (!extra.controllable) { banner('Control is not available (is the bot connected?)', 3000); return; }
    var s = state();
    yaw = s.yaw || 0; pitch = s.pitch || 0;
    setPlaying(true);
    var lock = document.body.requestPointerLock && document.body.requestPointerLock();
    if (lock && lock.catch) lock.catch(function () { banner('Mouse look needs pointer lock; keyboard still works.', 3000); });
  }

  document.getElementById('wrap').addEventListener('mousedown', function (event) {
    if (!extra.playing) { if (event.target !== chatInput) startPlaying(); return; }
    if (event.button === 0) {
      socket.emit('action', { action: 'attack' });
      clearInterval(attackTimer);
      attackTimer = setInterval(function () { socket.emit('action', { action: 'attack' }); }, 300);
    } else if (event.button === 2) {
      socket.emit('action', { action: 'use' });
    }
  });
  window.addEventListener('mouseup', function (event) { if (event.button === 0) { clearInterval(attackTimer); attackTimer = null; } });
  window.addEventListener('contextmenu', function (event) { event.preventDefault(); });

  document.addEventListener('pointerlockchange', function () {
    if (!document.pointerLockElement && extra.playing && chatBox.style.display !== 'block') setPlaying(false);
  });

  document.addEventListener('mousemove', function (event) {
    if (!extra.playing || document.pointerLockElement !== document.body) return;
    yaw -= event.movementX * 0.0022;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - event.movementY * 0.0022));
    lookDirty = true;
  });
  setInterval(function () {
    if (!lookDirty) return;
    lookDirty = false;
    socket.emit('look', { yaw: yaw, pitch: pitch });
  }, 33);
  setInterval(function () { if (extra.playing && Object.keys(held).some(function (k) { return held[k]; })) socket.emit('heartbeat'); }, 1000);

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
    if (resume) startPlaying(); else setPlaying(false);
  }
  chatInput.addEventListener('keydown', function (event) {
    event.stopPropagation();
    if (event.key === 'Enter') { var text = chatInput.value.trim(); if (text) socket.emit('chat', text); closeChat(true); }
    else if (event.key === 'Escape') closeChat(false);
  });

  window.addEventListener('keydown', function (event) {
    if (!extra.playing || event.repeat || chatBox.style.display === 'block') return;
    if (KEYS[event.code]) { emitInput(KEYS[event.code], true); event.preventDefault(); return; }
    if (/^Digit[1-9]$/.test(event.code)) { socket.emit('action', { action: 'slot', slot: Number(event.code.slice(5)) - 1 }); event.preventDefault(); return; }
    if (event.code === 'KeyQ') socket.emit('action', { action: 'drop' });
    else if (event.code === 'KeyF') socket.emit('action', { action: 'swap_hand' });
    else if (event.code === 'KeyT' || event.code === 'Enter') { event.preventDefault(); openChat(); }
  });
  window.addEventListener('keyup', function (event) { if (KEYS[event.code]) emitInput(KEYS[event.code], false); });
  window.addEventListener('blur', function () { releaseAll(); });
})();
