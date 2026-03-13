# WhatsApp Daemon Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js WhatsApp daemon (Baileys) with a local HTTP API and a stateless `wa` CLI that supports sending/receiving messages, groups, webhooks, and SQLite persistence.

**Architecture:** A long-running `daemon.js` process owns the Baileys connection and exposes a REST API on `localhost:3721`. A separate `cli.js` (symlinked as `wa`) makes HTTP calls to the daemon. IPC during startup uses a stdout pipe: the parent renders the QR and waits for a `"connected"` signal before detaching.

**Tech Stack:** Node.js 18+, `@whiskeysockets/baileys` v6, Express 4, `better-sqlite3`, `qrcode-terminal`, `axios`, `commander`, `pino`

---

## Chunk 1: Scaffold, Database, Webhooks

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize project**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
npm init -y
```

Replace `package.json` with:

```json
{
  "name": "whatsapp-daemon",
  "version": "1.0.0",
  "description": "WhatsApp daemon + CLI via Baileys",
  "main": "daemon.js",
  "type": "commonjs",
  "scripts": {
    "start": "node daemon.js",
    "test": "node --test tests/db.test.js tests/webhooks.test.js tests/server.test.js"
  },
  "bin": {
    "wa": "./cli.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.0",
    "express": "^4.18.0",
    "better-sqlite3": "^9.4.0",
    "qrcode-terminal": "^0.12.0",
    "axios": "^1.6.0",
    "commander": "^12.0.0",
    "pino": "^8.19.0"
  },
  "devDependencies": {
    "supertest": "^6.3.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create .gitignore**

Contents:
```
node_modules/
*.log
```

- [ ] **Step 4: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git init
git add package.json package-lock.json .gitignore
git commit -m "feat: project scaffold

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Database Layer (`lib/db.js`)

**Files:**
- Create: `lib/db.js`
- Create: `tests/db.test.js`

- [ ] **Step 1: Write failing tests — create `tests/db.test.js`**

```js
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
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && node --test tests/db.test.js
```

Expected: `Error: Cannot find module '../lib/db'`

- [ ] **Step 3: Create `lib/db.js`**

```js
'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const WA_DIR = process.env.WA_DIR || path.join(process.env.HOME, '.wa');
let _db = null;

function init() {
  fs.mkdirSync(WA_DIR, { recursive: true });
  _db = new Database(path.join(WA_DIR, 'messages.db'));
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL,
      sender_jid    TEXT NOT NULL,
      sender_name   TEXT,
      chat_jid      TEXT NOT NULL,
      chat_name     TEXT,
      text          TEXT,
      is_group      INTEGER NOT NULL DEFAULT 0,
      is_from_me    INTEGER NOT NULL DEFAULT 0,
      wa_message_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS groups (
      alias      TEXT PRIMARY KEY,
      jid        TEXT NOT NULL UNIQUE,
      name       TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      url        TEXT NOT NULL,
      events     TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function close() {
  if (_db) { _db.close(); _db = null; }
}

function insertMessage(msg) {
  _db.prepare(`
    INSERT OR IGNORE INTO messages
      (timestamp, sender_jid, sender_name, chat_jid, chat_name, text, is_group, is_from_me, wa_message_id)
    VALUES
      (@timestamp, @sender_jid, @sender_name, @chat_jid, @chat_name, @text, @is_group, @is_from_me, @wa_message_id)
  `).run(msg);
}

function getMessages({ limit = 20, from, chat_jid } = {}) {
  const cap = Math.min(Number(limit) || 20, 1000);
  let sql = 'SELECT * FROM messages WHERE 1=1';
  const params = [];
  if (from)     { sql += ' AND sender_jid = ?'; params.push(from); }
  if (chat_jid) { sql += ' AND chat_jid = ?';   params.push(chat_jid); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(cap);
  return _db.prepare(sql).all(...params);
}

function getMessageCount() {
  return _db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
}

function addGroup(alias, jid, name) {
  _db.prepare(
    'INSERT OR REPLACE INTO groups (alias, jid, name, created_at) VALUES (?, ?, ?, ?)'
  ).run(alias, jid, name || null, new Date().toISOString());
}

function removeGroup(alias) {
  _db.prepare('DELETE FROM groups WHERE alias = ?').run(alias);
}

function listGroups() {
  return _db.prepare('SELECT * FROM groups ORDER BY alias').all();
}

function getGroupByAlias(alias) {
  return _db.prepare('SELECT * FROM groups WHERE alias = ?').get(alias) || null;
}

function addWebhook(url, events) {
  return _db.prepare(
    'INSERT INTO webhooks (url, events, created_at) VALUES (?, ?, ?)'
  ).run(url, JSON.stringify(events), new Date().toISOString()).lastInsertRowid;
}

function removeWebhook(id) {
  _db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
}

function listWebhooks() {
  return _db.prepare('SELECT * FROM webhooks ORDER BY id').all();
}

module.exports = {
  init, close,
  insertMessage, getMessages, getMessageCount,
  addGroup, removeGroup, listGroups, getGroupByAlias,
  addWebhook, removeWebhook, listWebhooks
};
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && node --test tests/db.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add lib/db.js tests/db.test.js
git commit -m "feat: add SQLite database layer

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Webhook Dispatcher (`lib/webhooks.js`)

**Files:**
- Create: `lib/webhooks.js`
- Create: `tests/webhooks.test.js`

- [ ] **Step 1: Write failing tests — create `tests/webhooks.test.js`**

```js
const assert = require('assert');
const { test, before, after } = require('node:test');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wh-'));
process.env.WA_DIR = tmpDir;

const db = require('../lib/db');
const webhooks = require('../lib/webhooks');

const INDIVIDUAL = {
  event: 'message.individual', timestamp: '2026-01-01T00:00:00.000Z',
  sender_jid: '1111@s.whatsapp.net', sender_name: 'Alice',
  chat_jid: '1111@s.whatsapp.net', chat_name: 'Alice',
  text: 'Hello', is_group: false
};
const GROUP = {
  event: 'message.group', timestamp: '2026-01-01T00:00:00.000Z',
  sender_jid: '1111@s.whatsapp.net', sender_name: 'Alice',
  chat_jid: '999@g.us', chat_name: 'Friends',
  text: 'Hey', is_group: true
};

before(() => db.init());
after(() => { db.close(); fs.rmSync(tmpDir, { recursive: true }); });

function receiver(expectedBody) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(200); res.end();
        server.close();
        try { assert.deepEqual(JSON.parse(body), expectedBody); resolve(); }
        catch (e) { reject(e); }
      });
    });
    server.listen(0, () => {
      db.addWebhook(`http://localhost:${server.address().port}`, ['message']);
      webhooks.dispatch(expectedBody);
    });
  });
}

test('fires webhook for "message" on individual message', () => receiver(INDIVIDUAL));
test('fires webhook for "message" on group message', () => receiver(GROUP));

test('does NOT fire "message.group" webhook for individual', (t, done) => {
  let fired = false;
  const server = http.createServer((req, res) => { fired = true; res.writeHead(200); res.end(); });
  server.listen(0, () => {
    db.addWebhook(`http://localhost:${server.address().port}`, ['message.group']);
    webhooks.dispatch(INDIVIDUAL);
    setTimeout(() => { server.close(); assert.equal(fired, false); done(); }, 200);
  });
});

test('failed webhook POST does not throw', () => {
  db.addWebhook('http://localhost:1', ['message']);
  assert.doesNotThrow(() => webhooks.dispatch(INDIVIDUAL));
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && node --test tests/webhooks.test.js
```

Expected: `Error: Cannot find module '../lib/webhooks'`

- [ ] **Step 3: Create `lib/webhooks.js`**

```js
'use strict';
const axios = require('axios');
const db = require('./db');
const pino = require('pino');

const log = pino(
  { level: 'info' },
  pino.destination(process.env.WA_LOG || 2) // 2 = stderr fd
);

function dispatch(payload) {
  const hooks = db.listWebhooks();
  for (const hook of hooks) {
    let events;
    try { events = JSON.parse(hook.events); } catch { continue; }
    const matches = events.includes('message') || events.includes(payload.event);
    if (!matches) continue;
    axios.post(hook.url, payload, { timeout: 5000 })
      .catch(err => log.warn({ url: hook.url, err: err.message }, 'webhook POST failed'));
  }
}

module.exports = { dispatch };
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && node --test tests/webhooks.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add lib/webhooks.js tests/webhooks.test.js
git commit -m "feat: add webhook dispatcher

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 2: WhatsApp Client + HTTP Server

### Task 4: Baileys Wrapper (`lib/whatsapp.js`)

**Files:**
- Create: `lib/whatsapp.js`

> No unit tests: Baileys requires a live WhatsApp connection. Covered by smoke test in Task 8.

- [ ] **Step 1: Create `lib/whatsapp.js`**

```js
'use strict';
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const WA_DIR = process.env.WA_DIR || path.join(process.env.HOME, '.wa');
const SESSION_DIR = path.join(WA_DIR, 'session');

const silentLogger = pino({ level: 'silent' });

let sock = null;
let _state = 'disconnected';
let _onMessage = null;
let _onSignal = null;

async function start({ onMessage, onSignal } = {}) {
  _onMessage = onMessage || (() => {});
  _onSignal  = onSignal  || (() => {});
  _state = 'connecting';

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: silentLogger,
    printQRInTerminal: false,
    auth: state,
  });

  let qrTimer = null;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (qrTimer) clearTimeout(qrTimer);
      qrcode.generate(qr, { small: true }, (qrStr) => {
        process.stdout.write('\x1B[2J\x1B[0f');
        process.stdout.write(qrStr + '\nScan with WhatsApp > Linked Devices > Link a Device\n');
      });
      _onSignal('qr');
      qrTimer = setTimeout(() => {
        _onSignal('error: QR timeout — no scan within 25 seconds');
        process.exit(1);
      }, 25000);
    }

    if (connection === 'open') {
      if (qrTimer) clearTimeout(qrTimer);
      _state = 'connected';
      _onSignal('connected');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        _state = 'logged_out';
        _onSignal('error: logged out');
      } else if (_state !== 'logged_out') {
        _state = 'connecting';
        setTimeout(() => start({ onMessage: _onMessage, onSignal: () => {} }), 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;
      const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;
      _onMessage({
        wa_message_id: msg.key.id,
        timestamp: new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
        sender_jid: isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid,
        sender_name: msg.pushName || null,
        chat_jid: msg.key.remoteJid,
        chat_name: null,
        text,
        is_group: isGroup ? 1 : 0,
        is_from_me: msg.key.fromMe ? 1 : 0,
      });
    }
  });
}

async function sendMessage(jid, text) {
  if (!sock || _state !== 'connected') throw new Error('Not connected to WhatsApp');
  await sock.sendMessage(jid, { text });
}

async function logout() {
  if (sock) { try { await sock.logout(); } catch {} sock = null; }
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  _state = 'logged_out';
}

async function disconnect() {
  if (sock) { try { sock.end(); } catch {} sock = null; }
  _state = 'disconnected';
}

function getState() { return _state; }

module.exports = { start, sendMessage, logout, disconnect, getState };
```

- [ ] **Step 2: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add lib/whatsapp.js
git commit -m "feat: add Baileys WhatsApp client wrapper

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: HTTP API Server (`lib/server.js`)

**Files:**
- Create: `lib/server.js`
- Create: `tests/server.test.js`

- [ ] **Step 1: Write failing tests — create `tests/server.test.js`**

```js
const assert = require('assert');
const { test, before, after } = require('node:test');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-srv-'));
process.env.WA_DIR = tmpDir;

const db = require('../lib/db');
const { createApp } = require('../lib/server');

let server, baseUrl;
const mockWA = {
  getState: () => 'connected',
  sendMessage: async (jid, text) => { mockWA.lastSend = { jid, text }; },
  lastSend: null
};

before((done) => {
  db.init();
  const app = createApp({ wa: mockWA, startedAt: new Date().toISOString() });
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; done(); });
});

after(() => { server.close(); db.close(); fs.rmSync(tmpDir, { recursive: true }); });

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, baseUrl);
    const r = http.request(u, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || 'null') }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('GET /status returns state and uptime', async () => {
  const r = await req('GET', '/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'connected');
  assert.ok(r.body.uptime >= 0);
  assert.ok('message_count' in r.body);
});

test('POST /send valid phone sends and returns 200', async () => {
  const r = await req('POST', '/send', { phone: '+14155551234', message: 'Hi' });
  assert.equal(r.status, 200);
  assert.equal(mockWA.lastSend.jid, '14155551234@s.whatsapp.net');
});

test('POST /send invalid phone returns 400', async () => {
  const r = await req('POST', '/send', { phone: 'bad', message: 'Hi' });
  assert.equal(r.status, 400);
});

test('POST /send-group unknown alias returns 404', async () => {
  const r = await req('POST', '/send-group', { group: 'nobody', message: 'Hi' });
  assert.equal(r.status, 404);
});

test('POST /send-group raw JID returns 200', async () => {
  const r = await req('POST', '/send-group', { group: '123456789@g.us', message: 'Hey' });
  assert.equal(r.status, 200);
  assert.equal(mockWA.lastSend.jid, '123456789@g.us');
});

test('POST /send-group invalid non-alias non-JID returns 400', async () => {
  const r = await req('POST', '/send-group', { group: 'bad@bad', message: 'Hi' });
  assert.equal(r.status, 400);
});

test('GET /messages returns array', async () => {
  const r = await req('GET', '/messages');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

test('POST /groups + GET /groups + DELETE /groups/:alias round-trip', async () => {
  let r = await req('POST', '/groups', { alias: 'fam', jid: '999@g.us' });
  assert.equal(r.status, 200);
  r = await req('GET', '/groups');
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].alias, 'fam');
  r = await req('DELETE', '/groups/fam');
  assert.equal(r.status, 200);
  r = await req('GET', '/groups');
  assert.equal(r.body.length, 0);
});

test('POST /webhooks + GET /webhooks + DELETE /webhooks/:id round-trip', async () => {
  let r = await req('POST', '/webhooks', { url: 'https://x.com/hook' });
  assert.equal(r.status, 200);
  const id = r.body.id;
  r = await req('GET', '/webhooks');
  assert.equal(r.body.length, 1);
  r = await req('DELETE', `/webhooks/${id}`);
  assert.equal(r.status, 200);
  r = await req('GET', '/webhooks');
  assert.equal(r.body.length, 0);
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && node --test tests/server.test.js
```

Expected: `Error: Cannot find module '../lib/server'`

- [ ] **Step 3: Create `lib/server.js`**

```js
'use strict';
const express = require('express');
const db = require('./db');

const E164_RE = /^\+\d{7,15}$/;
const JID_GROUP_RE = /^\d+@g\.us$/;

function createApp({ wa, startedAt, onStop, onLogout }) {
  const app = express();
  app.use(express.json());

  app.get('/status', (_req, res) => {
    res.json({
      state: wa.getState(),
      uptime: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
      started_at: startedAt,
      message_count: db.getMessageCount()
    });
  });

  app.post('/send', async (req, res) => {
    const { phone, message } = req.body || {};
    if (!phone || !E164_RE.test(phone))
      return res.status(400).json({ error: 'phone must be E.164 (e.g. +14155551234)' });
    if (!message)
      return res.status(400).json({ error: 'message is required' });
    const state = wa.getState();
    if (state !== 'connected')
      return res.status(503).json({ error: `WhatsApp is ${state}` });
    const jid = phone.replace('+', '') + '@s.whatsapp.net';
    try {
      await wa.sendMessage(jid, message);
      db.insertMessage({
        timestamp: new Date().toISOString(), sender_jid: jid, sender_name: null,
        chat_jid: jid, chat_name: null, text: message, is_group: 0, is_from_me: 1,
        wa_message_id: `sent-${Date.now()}-${Math.random().toString(36).slice(2)}`
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/send-group', async (req, res) => {
    const { group, message } = req.body || {};
    if (!group || !message)
      return res.status(400).json({ error: 'group and message are required' });
    const state = wa.getState();
    if (state !== 'connected')
      return res.status(503).json({ error: `WhatsApp is ${state}` });
    let jid = group;
    if (!JID_GROUP_RE.test(group)) {
      const row = db.getGroupByAlias(group);
      if (!row) {
        if (group.includes('@'))
          return res.status(400).json({ error: 'Invalid group JID — expected digits@g.us' });
        return res.status(404).json({ error: `Group alias "${group}" not found` });
      }
      jid = row.jid;
    }
    try {
      await wa.sendMessage(jid, message);
      db.insertMessage({
        timestamp: new Date().toISOString(), sender_jid: jid, sender_name: null,
        chat_jid: jid, chat_name: null, text: message, is_group: 1, is_from_me: 1,
        wa_message_id: `sent-${Date.now()}-${Math.random().toString(36).slice(2)}`
      });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/messages', (req, res) => {
    const { limit, from, group } = req.query;
    let chat_jid, from_jid;
    if (group) {
      const row = db.getGroupByAlias(group);
      if (!row) return res.status(404).json({ error: `Group alias "${group}" not found` });
      chat_jid = row.jid;
    }
    if (from) {
      if (!E164_RE.test(from)) return res.status(400).json({ error: 'from must be E.164' });
      from_jid = from.replace('+', '') + '@s.whatsapp.net';
    }
    res.json(db.getMessages({ limit, from: from_jid, chat_jid }));
  });

  app.get('/groups',           (_req, res) => res.json(db.listGroups()));
  app.post('/groups',          (req, res)  => {
    const { alias, jid } = req.body || {};
    if (!alias || !jid) return res.status(400).json({ error: 'alias and jid required' });
    db.addGroup(alias, jid, null);
    res.json({ ok: true });
  });
  app.delete('/groups/:alias', (req, res)  => { db.removeGroup(req.params.alias); res.json({ ok: true }); });

  app.get('/webhooks', (_req, res) => {
    res.json(db.listWebhooks().map(h => ({ ...h, events: JSON.parse(h.events) })));
  });
  app.post('/webhooks', (req, res) => {
    const { url, events } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const id = db.addWebhook(url, Array.isArray(events) ? events : ['message']);
    res.json({ ok: true, id });
  });
  app.delete('/webhooks/:id', (req, res) => { db.removeWebhook(Number(req.params.id)); res.json({ ok: true }); });

  app.post('/stop', (_req, res) => {
    res.json({ ok: true });
    if (onStop) setTimeout(onStop, 500);
  });

  app.post('/logout', async (_req, res) => {
    try { if (onLogout) await onLogout(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  return app;
}

module.exports = { createApp };
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && node --test tests/server.test.js
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add lib/server.js tests/server.test.js
git commit -m "feat: add Express HTTP API server

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Chunk 3: Daemon, CLI, Install

### Task 6: Daemon Entry Point (`daemon.js`)

**Files:**
- Create: `daemon.js`

- [ ] **Step 1: Create `daemon.js`**

```js
#!/usr/bin/env node
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const pino = require('pino');

const WA_DIR = process.env.WA_DIR || path.join(process.env.HOME, '.wa');
const PID_FILE = path.join(WA_DIR, 'daemon.pid');
const LOG_FILE = path.join(WA_DIR, 'daemon.log');
const CONFIG_FILE = path.join(WA_DIR, 'config.json');

// Write PID immediately so `wa stop` can always reach us
fs.mkdirSync(WA_DIR, { recursive: true });
fs.writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(PID_FILE); } catch {} });

// Load config
let config = { port: 3721 };
if (fs.existsSync(CONFIG_FILE)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch (e) { process.stdout.write(`error: config.json malformed — ${e.message}\n`); process.exit(1); }
}

const log = pino({ level: 'info' }, pino.destination(LOG_FILE));

const db = require('./lib/db');
const wa = require('./lib/whatsapp');
const webhooks = require('./lib/webhooks');
const { createApp } = require('./lib/server');

db.init();

const startedAt = new Date().toISOString();

const app = createApp({
  wa,
  startedAt,
  onStop: async () => {
    log.info('Graceful shutdown');
    await wa.disconnect();
    db.close();
    setTimeout(() => process.exit(0), 500);
  },
  onLogout: async () => {
    await wa.logout();
    log.info('Logged out, session wiped');
  }
});

http.createServer(app).listen(config.port, '127.0.0.1', () => {
  log.info({ port: config.port }, 'HTTP server listening');
});

wa.start({
  onMessage: (msg) => {
    db.insertMessage(msg);
    if (msg.text !== null) {
      webhooks.dispatch({
        event: msg.is_group ? 'message.group' : 'message.individual',
        timestamp: msg.timestamp,
        sender_jid: msg.sender_jid,
        sender_name: msg.sender_name,
        chat_jid: msg.chat_jid,
        chat_name: msg.chat_name,
        text: msg.text,
        is_group: msg.is_group === 1
      });
    }
    log.info({ from: msg.sender_jid }, 'message received');
  },
  onSignal: (signal) => {
    process.stdout.write(signal + '\n');
    if (signal.startsWith('error:')) {
      db.close();
      setTimeout(() => process.exit(1), 200);
    }
  }
}).catch((err) => {
  process.stdout.write(`error: ${err.message}\n`);
  process.exit(1);
});

process.on('uncaughtException', (err) => log.error({ err }, 'uncaught exception'));
process.on('SIGTERM', async () => { await wa.disconnect(); db.close(); process.exit(0); });
```

- [ ] **Step 2: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add daemon.js
git commit -m "feat: add daemon entry point

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: CLI (`cli.js`)

**Files:**
- Create: `cli.js`

- [ ] **Step 1: Create `cli.js`**

```js
#!/usr/bin/env node
'use strict';
const { program } = require('commander');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const WA_DIR = process.env.WA_DIR || path.join(process.env.HOME, '.wa');
const PID_FILE = path.join(WA_DIR, 'daemon.pid');
const LOG_FILE = path.join(WA_DIR, 'daemon.log');
const CONFIG_FILE = path.join(WA_DIR, 'config.json');

function getPort() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).port || 3721; }
  catch { return 3721; }
}

const api = () => axios.create({ baseURL: `http://127.0.0.1:${getPort()}`, timeout: 10000 });

function daemonRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function requireDaemon() {
  if (!daemonRunning()) {
    console.error('Daemon is not running. Start it with: wa start');
    process.exit(1);
  }
}

function printTable(rows, cols) {
  if (!rows.length) { console.log('(none)'); return; }
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(r[c.key] ?? '').length)));
  console.log(cols.map((c, i) => c.label.padEnd(widths[i])).join('  '));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(cols.map((c, i) => String(r[c.key] ?? '').padEnd(widths[i])).join('  ')));
}

// --- wa start ---
program.command('start')
  .description('Start the daemon')
  .action(() => {
    if (daemonRunning()) {
      console.log(`Daemon is already running (PID ${fs.readFileSync(PID_FILE, 'utf8').trim()})`);
      return;
    }
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    fs.mkdirSync(WA_DIR, { recursive: true });

    const logFd = fs.openSync(LOG_FILE, 'a');
    const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
      detached: true,
      stdio: ['ignore', 'pipe', logFd]
    });

    console.log('Starting WhatsApp daemon...');
    let buffer = '';

    const timer = setTimeout(() => {
      console.error(`Daemon taking too long. Check logs: ${LOG_FILE}`);
      child.unref();
      process.exit(1);
    }, 30000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t === 'connected') {
          clearTimeout(timer);
          console.log('\n✓ WhatsApp connected. Daemon running in background.');
          child.unref();
          fs.closeSync(logFd);
          process.exit(0);
        } else if (t.startsWith('error:')) {
          clearTimeout(timer);
          console.error(`\n✗ ${t.replace('error: ', '')}`);
          child.unref();
          fs.closeSync(logFd);
          process.exit(1);
        } else {
          process.stdout.write(t + '\n');
        }
      }
    });

    child.on('exit', (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        console.error(`Daemon exited (code ${code}). Check: ${LOG_FILE}`);
        process.exit(1);
      }
    });
  });

// --- wa stop ---
program.command('stop').description('Stop the daemon').action(async () => {
  requireDaemon();
  try { await api().post('/stop'); console.log('Daemon stopped.'); }
  catch (e) { console.error('Error:', e.message); process.exit(1); }
});

// --- wa status ---
program.command('status').description('Show daemon status').action(async () => {
  requireDaemon();
  try {
    const { data: d } = await api().get('/status');
    const h = Math.floor(d.uptime / 3600), m = Math.floor((d.uptime % 3600) / 60), s = d.uptime % 60;
    console.log(`State:       ${d.state}`);
    console.log(`Uptime:      ${h}h ${m}m ${s}s`);
    console.log(`Messages:    ${d.message_count}`);
    console.log(`Started at:  ${d.started_at}`);
  } catch (e) { console.error('Error:', e.message); process.exit(1); }
});

// --- wa send ---
program.command('send <phone> <message>').description('Send to a phone number (E.164)').action(async (phone, message) => {
  requireDaemon();
  try { await api().post('/send', { phone, message }); console.log('✓ Sent'); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});

// --- wa send-group ---
program.command('send-group <group> <message>').description('Send to a group (alias or JID)').action(async (group, message) => {
  requireDaemon();
  try { await api().post('/send-group', { group, message }); console.log('✓ Sent'); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});

// --- wa messages ---
program.command('messages').description('Show recent messages')
  .option('--limit <n>', 'Number of messages', '20')
  .option('--from <phone>', 'Filter by phone (E.164)')
  .option('--group <alias>', 'Filter by group alias')
  .action(async (opts) => {
    requireDaemon();
    try {
      const params = { limit: opts.limit };
      if (opts.from)  params.from  = opts.from;
      if (opts.group) params.group = opts.group;
      const { data } = await api().get('/messages', { params });
      if (!data.length) { console.log('No messages.'); return; }
      [...data].reverse().forEach(m => {
        const dir = m.is_from_me ? '→' : '←';
        const who = m.sender_name || m.sender_jid;
        console.log(`[${new Date(m.timestamp).toLocaleString()}] ${dir} ${who}: ${m.text ?? '(media)'}`);
      });
    } catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
  });

// --- wa groups ---
const groups = program.command('groups').description('Manage group aliases');
groups.command('list', { isDefault: true }).description('List group aliases').action(async () => {
  requireDaemon();
  const { data } = await api().get('/groups');
  printTable(data, [{ key: 'alias', label: 'ALIAS' }, { key: 'jid', label: 'JID' }, { key: 'name', label: 'NAME' }]);
});
groups.command('add <alias> <jid>').description('Add a group alias').action(async (alias, jid) => {
  requireDaemon();
  try { await api().post('/groups', { alias, jid }); console.log(`✓ Group "${alias}" added`); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});
groups.command('remove <alias>').description('Remove a group alias').action(async (alias) => {
  requireDaemon();
  await api().delete(`/groups/${alias}`);
  console.log(`✓ Group "${alias}" removed`);
});

// --- wa webhooks ---
const hooks = program.command('webhooks').description('Manage webhooks');
hooks.command('list', { isDefault: true }).description('List webhooks').action(async () => {
  requireDaemon();
  const { data } = await api().get('/webhooks');
  printTable(data, [{ key: 'id', label: 'ID' }, { key: 'url', label: 'URL' }, { key: 'events', label: 'EVENTS' }]);
});
hooks.command('add <url>').description('Register a webhook')
  .option('--events <list>', 'Comma-separated events', 'message')
  .action(async (url, opts) => {
    requireDaemon();
    const events = opts.events.split(',').map(e => e.trim());
    try { const { data } = await api().post('/webhooks', { url, events }); console.log(`✓ Webhook registered (ID: ${data.id})`); }
    catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
  });
hooks.command('remove <id>').description('Remove a webhook').action(async (id) => {
  requireDaemon();
  await api().delete(`/webhooks/${id}`);
  console.log(`✓ Webhook ${id} removed`);
});

// --- wa logout ---
program.command('logout').description('Disconnect and wipe session').action(async () => {
  requireDaemon();
  try { await api().post('/logout'); console.log('✓ Logged out. Run: wa stop && wa start'); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});

program.parse(process.argv);
```

- [ ] **Step 2: Make scripts executable**

```bash
chmod +x /Users/thotas/Development/Claude/Whatsapp/cli.js
chmod +x /Users/thotas/Development/Claude/Whatsapp/daemon.js
```

- [ ] **Step 3: Commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add cli.js
git commit -m "feat: add CLI

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: Install + Smoke Test

- [ ] **Step 1: Link CLI globally**

```bash
cd /Users/thotas/Development/Claude/Whatsapp && npm link
```

Expected: `added 1 package` — `wa` now in PATH.

- [ ] **Step 2: Run all unit tests**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
node --test tests/db.test.js tests/webhooks.test.js tests/server.test.js
```

Expected: all tests pass, 0 failures.

- [ ] **Step 3: Start daemon**

```bash
wa start
```

Expected (first run): QR code in terminal. Scan with WhatsApp > Linked Devices > Link a Device.
Expected (subsequent): `✓ WhatsApp connected. Daemon running in background.`

- [ ] **Step 4: Check status**

```bash
wa status
```

Expected output:
```
State:       connected
Uptime:      0h 0m Xs
Messages:    0
Started at:  2026-...
```

- [ ] **Step 5: Send a test message**

```bash
wa send +<YOUR_NUMBER> "Hello from wa CLI"
```

Expected: `✓ Sent` — message arrives on your phone.

- [ ] **Step 6: Check message history**

```bash
wa messages
```

Expected: table with the sent message showing `→`.

- [ ] **Step 7: Stop daemon**

```bash
wa stop
```

Expected: `Daemon stopped.`

- [ ] **Step 8: Final commit**

```bash
cd /Users/thotas/Development/Claude/Whatsapp
git add -A
git commit -m "feat: complete WhatsApp daemon v1 — install and smoke test

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
