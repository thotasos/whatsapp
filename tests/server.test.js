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

before(async () => {
  db.init();
  const app = createApp({ wa: mockWA, startedAt: new Date().toISOString() });
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
  });
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
