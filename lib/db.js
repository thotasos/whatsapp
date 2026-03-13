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
