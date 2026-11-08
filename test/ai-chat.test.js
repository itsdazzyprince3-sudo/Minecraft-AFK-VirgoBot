'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_MEMORY_NOTE_LENGTH } = require('../lib/ai-memory');
const {
  createTrustedChatMemoryNote,
  getAIChatAllowedUsers,
  isAIChatAuthorized,
  parseAIChatCommand,
  shouldAutoRespondToChat
} = require('../lib/ai-chat');

test('AI chat command parser accepts slash and chat-prefix forms', () => {
  assert.deepEqual(parseAIChatCommand('!ai mine stone'), { type: 'task', text: 'mine stone' });
  assert.deepEqual(parseAIChatCommand('/ai ask what is nearby?'), { type: 'task', text: 'what is nearby?' });
  assert.deepEqual(parseAIChatCommand('!ai teach keep three logs'), {
    type: 'teach',
    text: 'keep three logs'
  });
  assert.deepEqual(parseAIChatCommand('/ai stop'), { type: 'stop' });
  assert.deepEqual(parseAIChatCommand('!ai pause'), { type: 'pause' });
  assert.deepEqual(parseAIChatCommand('/ai pause grinding'), { type: 'pause' });
  assert.deepEqual(parseAIChatCommand('!ai resume'), { type: 'resume' });
  assert.deepEqual(parseAIChatCommand('/ai resume grinding'), { type: 'resume' });
  assert.deepEqual(parseAIChatCommand('!ai'), { type: 'help' });
  assert.equal(parseAIChatCommand('hello Virgo'), null);
});

test('AI chat command parser handles sygget met command forms', () => {
  assert.deepEqual(parseAIChatCommand('!ai sygget'), { type: 'sygget', text: '' });
  assert.deepEqual(parseAIChatCommand('/ai sygget'), { type: 'sygget', text: '' });
  assert.deepEqual(parseAIChatCommand('!ai sygget me'), { type: 'sygget', text: '' });
  assert.deepEqual(parseAIChatCommand('!ai sygget mine 8 stone'), { type: 'sygget', text: 'mine 8 stone' });
  assert.deepEqual(parseAIChatCommand('/ai sygget me craft wooden_pickaxe'), { type: 'sygget', text: 'craft wooden_pickaxe' });
  assert.equal(parseAIChatCommand('sygget mine wood'), null);
});

test('AI chat authorization matches configured usernames without case sensitivity', () => {
  assert.equal(isAIChatAuthorized('Virgo', ['virgo']), true);
  assert.equal(isAIChatAuthorized(' virgo ', [' Virgo ']), true);
  assert.equal(isAIChatAuthorized(' ', ['virgo']), false);
  assert.equal(isAIChatAuthorized('OtherPlayer', ['virgo']), false);
  assert.equal(isAIChatAuthorized('Virgo', null), false);
});

test('AI command allowlist merges AI-specific and existing trusted chat users', () => {
  assert.deepEqual(
    getAIChatAllowedUsers(
      { allowedUsers: [' Virgo ', 'ADMIN'] },
      { tpWhitelist: ['virgo', 'Owner'] }
    ),
    ['virgo', 'admin', 'owner']
  );
  assert.deepEqual(getAIChatAllowedUsers({ allowedUsers: 'virgo' }, null), []);
});

test('automatic AI chat replies require opt-in and an AI-specific allowed user', () => {
  const config = { enabled: true, respondToTrustedChat: true, allowedUsers: ['commotozze'] };
  assert.equal(shouldAutoRespondToChat('commotozze', config), true);
  assert.equal(shouldAutoRespondToChat('other', config), false);
  assert.equal(shouldAutoRespondToChat('Virgo', { ...config, allowedUsers: [], tpWhitelist: ['Virgo'] }), false);
  assert.equal(shouldAutoRespondToChat('commotozze', { ...config, enabled: false }), false);
  assert.equal(shouldAutoRespondToChat('commotozze', { ...config, respondToTrustedChat: false }), false);
});

test('trusted chat memory includes only allowlisted players and bounds note length', () => {
  assert.equal(
    createTrustedChatMemoryNote('virgo', '  I prefer oak tools.  ', ['Virgo']),
    'virgo: I prefer oak tools.'
  );
  assert.equal(createTrustedChatMemoryNote('stranger', 'hello', ['Virgo']), null);
  assert.equal(createTrustedChatMemoryNote('Virgo', ' '.repeat(5), ['Virgo']), null);
  assert.equal(
    createTrustedChatMemoryNote('Virgo', 'x'.repeat(500), ['Virgo']).length,
    MAX_MEMORY_NOTE_LENGTH
  );
});
