'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_MEMORY_NOTE_LENGTH } = require('../lib/ai-memory');
const {
  createTrustedChatMemoryNote,
  getAIChatAllowedUsers,
  isPublicFollowRequest,
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
  assert.deepEqual(parseAIChatCommand('!ai fullauto'), { type: 'fullauto', action: 'start' });
  assert.deepEqual(parseAIChatCommand('/ai full autonomy'), { type: 'fullauto', action: 'start' });
  assert.deepEqual(parseAIChatCommand('!ai stop fullauto'), { type: 'fullauto', action: 'stop' });
  assert.deepEqual(parseAIChatCommand('/ai autoplay off'), { type: 'fullauto', action: 'stop' });
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

test('automatic AI chat replies honor the allowlist and explicit opt-out', () => {
  const config = { enabled: true, respondToTrustedChat: true, allowedUsers: ['commotozze'] };
  assert.equal(shouldAutoRespondToChat('commotozze', config), true);
  assert.equal(shouldAutoRespondToChat('other', config), false);
  assert.equal(shouldAutoRespondToChat('Virgo', { ...config, allowedUsers: [], tpWhitelist: ['Virgo'] }), false);
  assert.equal(shouldAutoRespondToChat('Owner', config, ['commotozze', 'owner']), true);
  assert.equal(shouldAutoRespondToChat('stranger', config, ['commotozze', 'owner']), false);
  assert.equal(shouldAutoRespondToChat('commotozze', { ...config, enabled: false }), false);
  assert.equal(shouldAutoRespondToChat('commotozze', { ...config, respondToTrustedChat: false }), false);
});

test('allowlisted users can start normal conversation without a prefix by default', () => {
  assert.equal(shouldAutoRespondToChat('Virgo', { enabled: true, allowedUsers: ['virgo'] }), true);
  assert.equal(shouldAutoRespondToChat('stranger', { enabled: true, allowedUsers: ['virgo'] }), false);
  assert.equal(shouldAutoRespondToChat('Virgo', { enabled: true, allowedUsers: ['virgo'], respondToChat: false }), false);
});

test('public follow requests can only target the speaker themself', () => {
  assert.equal(isPublicFollowRequest('follow'), true);
  assert.equal(isPublicFollowRequest('please follow me!'), true);
  assert.equal(isPublicFollowRequest('follow someoneElse'), false);
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
