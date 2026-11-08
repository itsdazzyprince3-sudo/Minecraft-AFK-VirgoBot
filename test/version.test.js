'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBotVersion } = require('../lib/version');

const baseConfig = version => ({ server: { version } });
const stableVersions = ['1.21.11', '26.1'];

test('blank version keeps Mineflayer auto-detection', () => {
  assert.deepEqual(resolveBotVersion(baseConfig(''), {}, stableVersions), {
    version: false,
    requested: '',
    fallback: false
  });
});

test('supported configured version is passed through unchanged', () => {
  assert.deepEqual(resolveBotVersion(baseConfig('26.1'), {}, stableVersions), {
    version: '26.1',
    requested: '26.1',
    fallback: false
  });
});

test('unsupported versions do not silently fall back to a different protocol', () => {
  assert.throws(
    () => resolveBotVersion(baseConfig('26.3'), {}, stableVersions),
    error => {
      assert.equal(error.code, 'ERR_UNSUPPORTED_MINECRAFT_VERSION');
      assert.match(error.message, /Minecraft version 26\.3 is not supported/);
      assert.match(error.message, /client version alone does not translate the server protocol/);
      return true;
    }
  );
});

test('explicit fallback is allowed only when it is supported by the installed protocol', () => {
  const config = { server: { version: '99.99', 'proxy-version-fallback': '26.1' } };
  assert.deepEqual(resolveBotVersion(config, {}, stableVersions), {
    version: '26.1',
    requested: '99.99',
    fallback: true
  });
});

test('unsupported fallback versions are rejected', () => {
  const config = { server: { version: '26.3', 'proxy-version-fallback': '26.3' } };
  assert.throws(
    () => resolveBotVersion(config, {}, stableVersions),
    /Minecraft version 26\.3 is not supported/
  );
});

test('unknown versions fail with an actionable error', () => {
  assert.throws(
    () => resolveBotVersion(baseConfig('99.99'), {}, stableVersions),
    /Minecraft version 99\.99 is not supported.*Supported versions:/s
  );
});
