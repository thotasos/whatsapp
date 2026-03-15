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
  },
  onGroups: (groups) => {
    for (const g of groups) {
      // Generate alias from group name: "Family Group" -> "family-group"
      const alias = g.name
        ? g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : g.jid.replace('@g.us', '');
      try {
        db.addGroup(alias, g.jid, g.name);
        log.info({ group: g.name, jid: g.jid }, 'group synced');
      } catch (e) {
        // Group already exists - that's fine
      }
    }
    log.info({ count: groups.length }, 'groups synced');
  }
}).catch((err) => {
  process.stdout.write(`error: ${err.message}\n`);
  process.exit(1);
});

process.on('uncaughtException', (err) => log.error({ err }, 'uncaught exception'));
process.on('SIGTERM', async () => { await wa.disconnect(); db.close(); process.exit(0); });
