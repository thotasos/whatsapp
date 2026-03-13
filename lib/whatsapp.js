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
let qrTimer = null;

async function start({ onMessage, onSignal } = {}) {
  _onMessage = onMessage || (() => {});
  _onSignal  = onSignal  || (() => {});
  _state = 'connecting';

  // Clean up previous socket before creating a new one
  if (sock) { try { sock.end(); } catch {} sock = null; }
  if (qrTimer) { clearTimeout(qrTimer); qrTimer = null; }

  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: silentLogger,
    printQRInTerminal: false,
    auth: state,
  });

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
