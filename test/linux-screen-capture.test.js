'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LinuxScreenCapture, parseWindowId, splitJpegFrames } = require('../lib/linux-screen-capture');

const frameA = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
const frameB = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9]);

test('X11 window IDs accept decimal and hex identifiers only', () => {
  assert.equal(parseWindowId('0xabc'), '0xabc');
  assert.equal(parseWindowId('1234'), '1234');
  assert.throws(() => parseWindowId('$(touch /tmp/nope)'), /Invalid X11 window id/);
});

test('MJPEG parser extracts complete frames and retains an incomplete tail', () => {
  const first = splitJpegFrames(Buffer.concat([Buffer.from('noise'), frameA, frameB.subarray(0, 4)]));
  assert.deepEqual(first.frames, [frameA]);
  assert.deepEqual(first.remainder, frameB.subarray(0, 4));
  const second = splitJpegFrames(Buffer.concat([first.remainder, frameB.subarray(4)]));
  assert.deepEqual(second.frames, [frameB]);
  assert.equal(second.remainder.length, 0);
});

test('capture exposes the freshest complete JPEG and rejects stale frames', () => {
  const capture = new LinuxScreenCapture({ platform: 'linux', display: ':99', windowId: '0x123' });
  capture.handleData(Buffer.concat([frameA, frameB]));
  assert.deepEqual(capture.getFrame(), frameB);
  assert.equal(capture.status().ready, true);
  capture.capturedAt = Date.now() - 6000;
  assert.throws(() => capture.getFrame(), /No recent Minecraft-window frame/);
});

test('capture refuses non-Linux hosts and missing X11 displays before spawning', () => {
  const windows = new LinuxScreenCapture({ platform: 'win32', display: ':0', windowId: '0x123' });
  assert.throws(() => windows.start(), /Linux X11 only/);
  const noDisplay = new LinuxScreenCapture({ platform: 'linux', display: '', windowId: '0x123' });
  noDisplay.display = '';
  assert.throws(() => noDisplay.start(), /No X11 DISPLAY/);
});

test('desktop controls require opt-in and target the selected window', async () => {
  const calls = [];
  const run = async (_command, args) => { calls.push(args); };
  const blocked = new LinuxScreenCapture({ platform: 'linux', display: ':0', windowId: '0x123', execFileAsync: run });
  await assert.rejects(blocked.performAction('attack'), /controlWindow=true/);
  const allowed = new LinuxScreenCapture({
    platform: 'linux', display: ':0', windowId: '0x123', controlEnabled: true, execFileAsync: run
  });
  await allowed.performAction('turn_left');
  assert.deepEqual(calls, [
    ['windowactivate', '--sync', '0x123'],
    ['mousemove_relative', '--', '-130', '0']
  ]);
});
