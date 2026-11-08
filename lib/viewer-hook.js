/* Runs inside the 3D view iframe BEFORE prismarine-viewer's bundle (see browser-viewer.js).
 *
 * prismarine-viewer keeps its camera and scene private, but it renders through
 * THREE.WebGLRenderer.prototype.render. We wrap that one method so the page around it can
 *   - look around with zero latency (client-side mouse look, the server is told in parallel),
 *   - move the camera for third person, and
 *   - tune sky colour, fog and light strength.
 * The viewer's own camera is never modified: `derive` may return a different camera to render
 * with, so the viewer's position tween and server-driven rotation keep working untouched.
 * If anything here fails the viewer renders exactly as it did without the hook. */
(function () {
  'use strict';
  var hook = (window.__vhook = { scene: null, renderer: null, viewerCamera: null, camera: null, derive: null, frames: 0, error: '' });

  function patch(THREE) {
    if (!THREE || !THREE.WebGLRenderer || THREE.__vhooked) return;
    THREE.__vhooked = true;
    var proto = THREE.WebGLRenderer.prototype;
    var original = proto.render;
    proto.render = function (scene, camera) {
      hook.scene = scene;
      hook.renderer = this;
      hook.viewerCamera = camera;
      hook.frames++;
      var use = camera;
      if (hook.derive) {
        try { use = hook.derive(scene, camera, this) || camera; } catch (error) { hook.error = String(error && error.message || error); use = camera; }
      }
      hook.camera = use;           // the camera actually rendered with (read by tests)
      return original.call(this, scene, use);
    };
  }

  if (window.THREE) {
    patch(window.THREE);
  } else {
    // The bundle assigns `global.THREE = require('three')`; catch that assignment.
    var value;
    Object.defineProperty(window, 'THREE', {
      configurable: true,
      get: function () { return value; },
      set: function (next) { value = next; patch(next); }
    });
  }
})();
