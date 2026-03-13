const assert = require('assert');
const { test, before, after } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'));
process.env.WA_DIR = tmpDir;

const db = require('../lib/db');

before(() => db.init());
after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true }); });

test('insertMessage stores a message and getMessages retrieves it', () => {
  db.insertMessage({
    timestamp: '2026-01-01T00:00:00.000Z',
    sender_jid: '1111@s.whatsapp.net', sender_name: 'Alice',
    chat_jid: '1111@s.whatsapp.net', chat_name: 'Alice',
    text: 'Hello', is_group: 0, is_from_me: 0, wa_message_id: 'msg-001'
  });
  const rows = db.getMessages({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'Hello');
});

test('insertMessage is idempotent on duplicate wa_message_id', () => {
  db.insertMessage({
    timestamp: '2026-01-01T00:00:01.000Z',
    sender_jid: '1111@s.whatsapp.net', sender_name: 'Alice',
    chat_jid: '1111@s.whatsapp.net', chat_name: 'Alice',
    text: 'Duplicate', is_group: 0, is_from_me: 0, wa_message_id: 'msg-001'
  });
  assert.equal(db.getMessages({ limit: 10 }).length, 1);
});

test('getMessages filters by sender_jid', () => {
  db.insertMessage({
    timestamp: '2026-01-01T00:01:00.000Z',
    sender_jid: '2222@s.whatsapp.net', sender_name: 'Bob',
    chat_jid: '2222@s.whatsapp.net', chat_name: 'Bob',
    text: 'Hi', is_group: 0, is_from_me: 0, wa_message_id: 'msg-002'
  });
  const rows = db.getMessages({ limit: 10, from: '1111@s.whatsapp.net' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender_jid, '1111@s.whatsapp.net');
});

test('addGroup, listGroups, removeGroup work correctly', () => {
  db.addGroup('friends', '999@g.us', 'Friends Group');
  const groups = db.listGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].alias, 'friends');
  db.removeGroup('friends');
  assert.equal(db.listGroups().length, 0);
});

test('getGroupByAlias returns null for unknown alias', () => {
  assert.equal(db.getGroupByAlias('nobody'), null);
});

test('addWebhook, listWebhooks, removeWebhook work correctly', () => {
  const id = db.addWebhook('https://example.com/hook', ['message']);
  const hooks = db.listWebhooks();
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].url, 'https://example.com/hook');
  db.removeWebhook(id);
  assert.equal(db.listWebhooks().length, 0);
});
