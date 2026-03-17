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

// --- wa send-media ---
program.command('send-media <target> <file>')
  .description('Send media to a group or phone')
  .option('--caption <text>', 'Caption for the media')
  .action(async (target, file, opts) => {
    requireDaemon();
    if (!fs.existsSync(file)) { console.error('File not found:', file); process.exit(1); }
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('target', target);
      if (opts.caption) form.append('caption', opts.caption);
      form.append('media', fs.createReadStream(file), { filename: path.basename(file) });
      await api().post('/send-media', form, { headers: form.getHeaders() });
      console.log('✓ Sent');
    } catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
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
        const content = m.text || (m.media_path ? `(media: ${m.media_path})` : '(media)');
        console.log(`[${new Date(m.timestamp).toLocaleString()}] ${dir} ${who}: ${content}`);
      });
    } catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
  });

// --- wa groups ---
const groups = program.command('groups').description('Manage group aliases');
groups.command('list', { isDefault: true }).description('List group aliases').action(async () => {
  requireDaemon();
  try {
    const { data } = await api().get('/groups');
    printTable(data, [{ key: 'alias', label: 'ALIAS' }, { key: 'jid', label: 'JID' }, { key: 'name', label: 'NAME' }]);
  } catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});
groups.command('add <alias> <jid>').description('Add a group alias').action(async (alias, jid) => {
  requireDaemon();
  try { await api().post('/groups', { alias, jid }); console.log(`✓ Group "${alias}" added`); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});
groups.command('remove <alias>').description('Remove a group alias').action(async (alias) => {
  requireDaemon();
  try { await api().delete(`/groups/${alias}`); console.log(`✓ Group "${alias}" removed`); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});

// --- wa webhooks ---
const hooks = program.command('webhooks').description('Manage webhooks');
hooks.command('list', { isDefault: true }).description('List webhooks').action(async () => {
  requireDaemon();
  try {
    const { data } = await api().get('/webhooks');
    printTable(data, [{ key: 'id', label: 'ID' }, { key: 'url', label: 'URL' }, { key: 'events', label: 'EVENTS' }]);
  } catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
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
  try { await api().delete(`/webhooks/${id}`); console.log(`✓ Webhook ${id} removed`); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});

// --- wa logout ---
program.command('logout').description('Disconnect and wipe session').action(async () => {
  requireDaemon();
  try { await api().post('/logout'); console.log('✓ Logged out. Run: wa stop && wa start'); }
  catch (e) { console.error('Error:', e.response?.data?.error || e.message); process.exit(1); }
});

program.parse(process.argv);
