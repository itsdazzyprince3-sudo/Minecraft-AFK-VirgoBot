'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserViewer, secretsMatch, readCookie } = require('../lib/browser-viewer');

test('secretsMatch only accepts an identical non-empty secret', () => {
  assert.equal(secretsMatch('abc123', 'abc123'), true);
  assert.equal(secretsMatch('abc123', 'abc124'), false);
  assert.equal(secretsMatch('abc123', 'abc'), false);
  assert.equal(secretsMatch('', ''), false);
  assert.equal(secretsMatch(undefined, undefined), false);
});

test('readCookie extracts and decodes a named cookie', () => {
  assert.equal(readCookie('a=1; viewer_token=t%30ken; b=2', 'viewer_token'), 't0ken');
  assert.equal(readCookie('a=1', 'viewer_token'), '');
  assert.equal(readCookie(undefined, 'viewer_token'), '');
});

test('viewer authorizes by query token or cookie and rejects everything else', () => {
  const viewer = new BrowserViewer({ token: 'secret', log: () => {} });
  assert.equal(viewer.isAuthorized('', 'secret'), true);
  assert.equal(viewer.isAuthorized('viewer_token=secret', ''), true);
  assert.equal(viewer.isAuthorized('viewer_token=wrong', 'nope'), false);
  assert.equal(viewer.isAuthorized('', ''), false);
});

test('viewer refuses to start without a dashboard token', () => {
  const logs = [];
  const viewer = new BrowserViewer({ token: '', log: message => logs.push(message) });
  assert.equal(viewer.start(), false);
  assert.match(logs[0], /DASHBOARD_TOKEN/);
});
