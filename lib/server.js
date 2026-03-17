'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const E164_RE = /^\+\d{7,15}$/;
const JID_GROUP_RE = /^[\d-]+@g\.us$/;

const upload = multer({ dest: '/tmp/' });

function createApp({ wa, startedAt, onStop, onLogout }) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

  app.post('/send-media', upload.single('media'), async (req, res) => {
    const { target, caption } = req.body || {};
    if (!target || !req.file)
      return res.status(400).json({ error: 'target and media file are required' });
    const state = wa.getState();
    if (state !== 'connected')
      return res.status(503).json({ error: `WhatsApp is ${state}` });

    // Resolve target to JID
    let jid = target;
    if (E164_RE.test(target)) {
      jid = target.replace('+', '') + '@s.whatsapp.net';
    } else if (!JID_GROUP_RE.test(target)) {
      const row = db.getGroupByAlias(target);
      if (!row) return res.status(404).json({ error: `Group "${target}" not found` });
      jid = row.jid;
    }

    try {
      const mediaBuffer = fs.readFileSync(req.file.path);
      const ext = path.extname(req.file.originalname).slice(1) || 'jpg';
      const mimeType = ext === 'jpg' ? 'image/jpeg' : ext === 'mp4' ? 'video/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'application/octet-stream';
      const fileName = req.file.originalname;

      await wa.sendMedia(jid, mediaBuffer, mimeType, caption, fileName);

      // Clean up temp file
      fs.unlinkSync(req.file.path);

      db.insertMessage({
        timestamp: new Date().toISOString(), sender_jid: jid, sender_name: null,
        chat_jid: jid, chat_name: null, text: caption || null, is_group: jid.endsWith('@g.us') ? 1 : 0, is_from_me: 1,
        wa_message_id: `sent-${Date.now()}-${Math.random().toString(36).slice(2)}`
      });
      res.json({ ok: true });
    } catch (e) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ error: e.message });
    }
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
    res.json(db.listWebhooks());
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
