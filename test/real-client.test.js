'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { secretsMatch, readCookie, captureArgs } = require('../real-client/screen-server');

test('screen server compares tokens exactly and refuses empty secrets', () => {
  assert.equal(secretsMatch('abc', 'abc'), true);
  assert.equal(secretsMatch('abc', 'abd'), false);
  assert.equal(secretsMatch('abc', ''), false);
  assert.equal(secretsMatch('', ''), false);
});

test('screen server reads the token cookie', () => {
  assert.equal(readCookie('x=1; screen_token=t%30ken', 'screen_token'), 't0ken');
  assert.equal(readCookie('', 'screen_token'), '');
});

test('capture command grabs the screen and streams JPEG frames to stdout', () => {
  const args = captureArgs();
  assert.ok(args.includes('image2pipe'));
  assert.ok(args.includes('mjpeg'));
  assert.equal(args[args.length - 1], '-');
  assert.ok(args.some(arg => ['x11grab', 'gdigrab', 'avfoundation'].includes(arg)));
});
