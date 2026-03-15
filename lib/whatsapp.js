'use strict';
const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const WA_DIR = process.env.WA_DIR || path.join(process.env.HOME, '.wa');
const SESSION_DIR = path.join(WA_DIR, 'session');
const MEDIA_DIR = path.join(WA_DIR, 'media');

const silentLogger = pino({ level: 'silent' });

// Ensure media directory exists
fs.mkdirSync(MEDIA_DIR, { recursive: true });

let sock = null;
let _state = 'disconnected';
let _onMessage = null;
let _onSignal = null;
let _onGroups = null;
let qrTimer = null;

async function saveMedia(msg) {
  try {
    const msgContext = msg.message;
    if (!msgContext) return null;

    // Check for different media types
    const mediaTypes = [
      'imageMessage', 'videoMessage', 'audioMessage',
      'documentMessage', 'stickerMessage'
    ];

    for (const type of mediaTypes) {
      const media = msgContext[type];
      if (media) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger });
        if (!buffer) return null;

        // Get file extension from mimetype
        const ext = media.mimetype?.split('/')[1] || 'bin';
        // Use a safe filename
        const filename = `${msg.key.id}.${ext}`;
        const filepath = path.join(MEDIA_DIR, filename);

        fs.writeFileSync(filepath, buffer);
        return filepath;
      }
    }
    return null;
  } catch (e) {
    console.error('Media download failed:', e.message);
    return null;
  }
}

async function start({ onMessage, onSignal, onGroups } = {}) {
  _onMessage = onMessage || (() => {});
  _onSignal  = onSignal  || (() => {});
  _onGroups  = onGroups  || (() => {});
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

      // Fetch groups after connection opens
      sock.groupFetchAllParticipating().then((groups) => {
        const groupList = Object.values(groups).map(g => ({
          jid: g.id,
          name: g.subject,
          size: g.size
        }));
        _onGroups(groupList);
      }).catch(err => {
        console.error('Failed to fetch groups:', err.message);
      });
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;

      // Download media if present
      const mediaPath = await saveMedia(msg);

      const isGroup = msg.key.remoteJid?.endsWith('@g.us') || false;
      _onMessage({
        wa_message_id: msg.key.id,
        timestamp: new Date(Number(msg.messageTimestamp) * 1000).toISOString(),
        sender_jid: isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid,
        sender_name: msg.pushName || null,
        chat_jid: msg.key.remoteJid,
        chat_name: null,
        text,
        media_path: mediaPath,
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

async function sendMedia(jid, buffer, mimeType, caption) {
  if (!sock || _state !== 'connected') throw new Error('Not connected to WhatsApp');
  const mediaType = mimeType.startsWith('image/') ? 'image' :
                    mimeType.startsWith('video/') ? 'video' :
                    mimeType.startsWith('audio/') ? 'audio' : 'document';
  await sock.sendMessage(jid, {
    [mediaType]: buffer,
    caption: caption || undefined,
    mimetype: mimeType
  });
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

module.exports = { start, sendMessage, sendMedia, logout, disconnect, getState };
