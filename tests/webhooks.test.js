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

test('failed webhook POST does not produce unhandled rejection', async () => {
  db.addWebhook('http://localhost:1', ['message']); // port 1 refuses connections
  const rejections = [];
  const handler = (reason) => rejections.push(reason);
  process.on('unhandledRejection', handler);
  webhooks.dispatch(INDIVIDUAL);
  await new Promise(r => setTimeout(r, 500));
  process.off('unhandledRejection', handler);
  assert.equal(rejections.length, 0, 'unhandled rejection detected — .catch may be missing');
});
