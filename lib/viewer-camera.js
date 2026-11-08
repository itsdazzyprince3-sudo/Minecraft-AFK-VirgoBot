/* Camera and lighting for the browser view: first person with zero-latency mouse look,
 * third person (back / front) like F5 in the game, field of view, sky colour, fog and light
 * strength driven by the bot's real light level and the time of day.
 *
 * It drives the render hook injected by browser-viewer.js (viewer-hook.js). The pure maths
 * is exported for tests; the browser part only runs when there is a page. */
(function (root) {
  'use strict';

  var MAX_DISTANCE = 4;               // third-person camera distance in blocks (as in the game)
  var DAY = [0.47, 0.65, 1.0];
  var NIGHT = [0.02, 0.03, 0.09];
  var CAVE = [0.015, 0.015, 0.02];

  // Same convention as mineflayer: yaw 0 looks north (-Z), pitch > 0 looks up.
  function viewDir(yaw, pitch) {
    return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  }

  // pov: 0 first person, 1 third person behind, 2 third person in front looking back.
  // clearBack/clearFront are collision-limited distances reported by the server.
  function cameraPose(eye, yaw, pitch, pov, clearBack, clearFront) {
    if (pov !== 1 && pov !== 2) return { pos: eye.slice(), yaw: yaw, pitch: pitch };
    var limit = pov === 1 ? clearBack : clearFront;
    var distance = Math.max(0.3, Math.min(MAX_DISTANCE, limit == null ? MAX_DISTANCE : limit));
    var dir = viewDir(yaw, pitch);
    var sign = pov === 1 ? -1 : 1;
    return {
      pos: [eye[0] + dir[0] * distance * sign, eye[1] + dir[1] * distance * sign, eye[2] + dir[2] * distance * sign],
      yaw: pov === 1 ? yaw : yaw + Math.PI,
      pitch: pov === 1 ? pitch : -pitch
    };
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // What the lights should be right now. ambient/sun are multipliers of the viewer's defaults.
  // `state` is /api/hud: skyBrightness (time of day, 0..1) and light {known, eff, sky, block}.
  function lightingTarget(state, mode) {
    var day = { ambient: 1, sun: 1, color: DAY.slice() };
    if (mode === 'bright' || !state || !state.connected) return day;
    var sky = state.skyBrightness == null ? 1 : state.skyBrightness;
    var light = state.light;
    var known = Boolean(light && light.known);
    // Without real light data from the server fall back to the time of day alone.
    var level = known ? light.eff : Math.round(15 * (0.35 + 0.65 * sky));
    var openSky = !known || light.sky > 0;
    var color = mix(NIGHT, DAY, sky);
    if (!openSky) color = mix(color, CAVE, 0.85);
    return {
      ambient: 0.2 + 0.8 * (level / 15),
      sun: sky * (openSky ? 1 : 0.25),
      color: color
    };
  }

  var api = { MAX_DISTANCE: MAX_DISTANCE, viewDir: viewDir, cameraPose: cameraPose, lightingTarget: lightingTarget, mix: mix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- browser part
  var extra = (window.hudExtra = window.hudExtra || {});
  var frame = document.getElementById('world');
  var my = null;
  var base = null;          // the viewer's own light intensities, captured once
  var cur = null;           // smoothed lighting
  var lastTime = performance.now();
  var POV_NAMES = ['First person', 'Third person (back)', 'Third person (front)'];
  extra.pov = 0;
  extra.fov = 75;
  extra.lighting = 'auto';
  extra.fog = true;

  function hook() {
    try { return frame.contentWindow && frame.contentWindow.__vhook; } catch (e) { return null; }
  }

  function applyLighting(scene, THREE, dt) {
    if (!base) {
      base = { ambient: 1, sun: 0.5, ambientLight: null, sunLight: null };
      for (var i = 0; i < scene.children.length; i++) {
        var child = scene.children[i];
        if (child.isAmbientLight && !base.ambientLight) { base.ambientLight = child; base.ambient = child.intensity; }
        if (child.isDirectionalLight && !base.sunLight) { base.sunLight = child; base.sun = child.intensity; }
      }
    }
    var state = (window.hudApi && window.hudApi.state()) || {};
    var target = lightingTarget(state, extra.lighting);
    if (!cur) cur = { ambient: target.ambient, sun: target.sun, color: target.color.slice() };
    var k = 1 - Math.exp(-dt * 3);       // ease over roughly a third of a second
    cur.ambient += (target.ambient - cur.ambient) * k;
    cur.sun += (target.sun - cur.sun) * k;
    cur.color = mix(cur.color, target.color, k);
    if (base.ambientLight) base.ambientLight.intensity = base.ambient * cur.ambient;
    if (base.sunLight) base.sunLight.intensity = base.sun * cur.sun;
    if (scene.background && scene.background.setRGB) scene.background.setRGB(cur.color[0], cur.color[1], cur.color[2]);
    if (extra.fog && state.viewDistance) {
      var far = Math.max(32, state.viewDistance * 16 - 4);
      if (!scene.fog) scene.fog = new THREE.Fog(0xffffff, far * 0.5, far);
      scene.fog.near = far * 0.5;
      scene.fog.far = far;
      scene.fog.color.setRGB(cur.color[0], cur.color[1], cur.color[2]);
    } else if (scene.fog) {
      scene.fog = null;
    }
  }

  function derive(scene, vcam) {
    var now = performance.now();
    var dt = Math.min(0.25, (now - lastTime) / 1000);
    lastTime = now;
    var THREE = frame.contentWindow.THREE;
    applyLighting(scene, THREE, dt);

    var pov = extra.pov | 0;
    var fov = extra.fov || 75;
    var predicted = extra.playing && extra.look;
    if (pov === 0 && !predicted && fov === 75) return vcam;     // untouched passthrough

    if (!my) my = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    if (my.fov !== fov || my.aspect !== vcam.aspect || my.near !== vcam.near || my.far !== vcam.far) {
      my.fov = fov; my.aspect = vcam.aspect; my.near = vcam.near; my.far = vcam.far;
      my.updateProjectionMatrix();
    }
    var yaw = predicted ? extra.look.yaw : vcam.rotation.y;
    var pitch = predicted ? extra.look.pitch : vcam.rotation.x;
    var pose = extra.pose || {};
    var out = cameraPose([vcam.position.x, vcam.position.y, vcam.position.z], yaw, pitch, pov, pose.back, pose.front);
    my.position.set(out.pos[0], out.pos[1], out.pos[2]);
    my.rotation.set(out.pitch, out.yaw, 0, 'ZYX');
    return my;
  }

  function install() {
    var h = hook();
    if (h && h.derive !== derive) h.derive = derive;
    extra.hooked = Boolean(h && h.derive === derive);
  }
  frame.addEventListener('load', function () { install(); setTimeout(install, 500); setTimeout(install, 2500); });
  setInterval(install, 3000);

  window.camApi = {
    cyclePov: function () { extra.pov = (extra.pov + 1) % 3; return POV_NAMES[extra.pov]; },
    povName: function () { return POV_NAMES[extra.pov | 0]; },
    setFov: function (value) { extra.fov = Math.max(50, Math.min(110, Math.round(value))); return extra.fov; },
    cycleLighting: function () { extra.lighting = extra.lighting === 'auto' ? 'bright' : 'auto'; return extra.lighting; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
