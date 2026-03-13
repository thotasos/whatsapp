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
