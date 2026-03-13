# WhatsApp Daemon Design

**Date:** 2026-03-13
**Status:** Approved

---

## Overview

A complete WhatsApp program split into two processes:
1. **Daemon** — long-running background process that owns the WhatsApp connection and exposes a local HTTP API
2. **CLI** (`wa`) — stateless command-line tool that talks to the daemon via HTTP

Built with Node.js and Baileys (`@whiskeysockets/baileys` v6.x), which implements the WhatsApp multi-device protocol directly — no browser required.

**Prerequisites:** Node.js 18+

---

## Architecture

### Processes

```
wa start
  └── Spawns daemon.js as a detached child process immediately
        ├── Daemon starts Baileys, writes QR to a temp file / stdout pipe
        ├── Parent reads QR output from pipe and renders it in terminal
        ├── Daemon signals "connected" via stdout pipe
        ├── Parent sees "connected" → closes pipe, exits cleanly (terminal returns)
        └── Daemon continues in background
              ├── Baileys WhatsApp client
              ├── Express HTTP server on localhost:3721
              ├── SQLite message store
              └── Webhook dispatcher
```

The parent process always spawns the daemon as a detached background child from the start. It keeps a pipe to the child's stdout only long enough to relay the QR code and wait for the "connected" signal (or error). This avoids forking after a live Baileys connection is established.

### Startup Confirmation Window

After spawning the daemon, the parent waits up to **30 seconds** for one of:
- `"connected"` signal → parent exits 0 (success)
- `"error: <message>"` signal → parent prints error and exits 1
- Timeout → parent prints "Daemon is taking too long to connect. Check logs: `~/.wa/daemon.log`" and exits 1

The daemon writes its PID file **immediately on startup** (before QR or connection), so `wa stop` can reach it at any point — even if the parent has timed out and exited.

### File Structure

```
Whatsapp/
├── package.json
├── daemon.js          # Daemon entry point
├── cli.js             # CLI entry point (symlinked as `wa`)
└── lib/
    ├── whatsapp.js    # Baileys client wrapper (QR, connect, send, receive)
    ├── db.js          # SQLite schema + queries (better-sqlite3)
    ├── server.js      # Express HTTP API routes
    └── webhooks.js    # Webhook dispatcher

~/.wa/                 # Created by daemon before forking background child
├── daemon.pid         # PID of running daemon
├── daemon.log         # Daemon stdout/stderr log
├── config.json        # Port + other config (created with defaults if absent)
├── session/           # Baileys auth state (persisted credentials)
└── messages.db        # SQLite database
```

---

## Session Persistence

Baileys saves credentials to `~/.wa/session/` after the first QR scan. On subsequent `wa start` calls, the daemon loads the saved session and connects without a QR code (parent still waits up to 30s for the "connected" signal, then exits).

The session is only invalidated when:
- `wa logout` is run (daemon calls Baileys `logout()`, then deletes `~/.wa/session/`)
- The device is unlinked from WhatsApp on the phone
- `~/.wa/session/` is manually deleted

---

## Startup Flow (Detailed)

1. `wa start` is invoked
2. Check `~/.wa/daemon.pid` — if PID exists and process is alive, print "Daemon is already running (PID N)" and exit
3. If PID file exists but process is dead (stale PID), delete the stale file and proceed
4. Create `~/.wa/` directory if it does not exist
5. Spawn `daemon.js` as a detached child with `stdio: ['ignore', pipe, logfile]`
6. Daemon starts, Baileys initializes:
   - **No session:** Baileys emits QR → daemon writes QR to stdout pipe → parent renders QR in terminal. Waits for scan.
   - **Session exists:** Baileys restores session, connects.
7. On successful connection: daemon writes `"connected\n"` to stdout pipe, writes PID to `~/.wa/daemon.pid`
8. Parent reads `"connected"` → unrefs child, exits cleanly
9. On failure: daemon writes `"error: <reason>\n"` to stdout pipe; parent prints error and exits 1

**QR timeout:** If no scan occurs within **25 seconds**, the daemon exits with `"error: QR timeout\n"` and the parent reports it. (QR timeout is shorter than the 30s parent window so the daemon always exits cleanly before the parent times out — preventing orphaned daemon processes.)

**QR refresh:** Baileys may re-emit the QR code before the timeout. Each new QR line from the pipe replaces the previous terminal render. The parent re-renders the QR in place until "connected" or "error" is received.

---

## HTTP API

The daemon listens on `localhost:3721` (configurable via `~/.wa/config.json`).

All responses are JSON. Errors return `{ "error": "message" }` with an appropriate HTTP status code.

| Method | Path | Body / Query | Description |
|--------|------|--------------|-------------|
| `GET` | `/status` | — | Daemon health, connection state, uptime, message count |
| `POST` | `/send` | `{ phone, message }` | Send to phone number (E.164, e.g. `+14155551234`) |
| `POST` | `/send-group` | `{ group, message }` | Send to group (alias or full JID) |
| `GET` | `/messages` | `?limit&from&group` | Query stored messages |
| `GET` | `/groups` | — | List configured group aliases (manually added only) |
| `POST` | `/groups` | `{ alias, jid }` | Add group alias |
| `DELETE` | `/groups/:alias` | — | Remove group alias |
| `GET` | `/webhooks` | — | List registered webhooks |
| `POST` | `/webhooks` | `{ url, events? }` | Register webhook (`events` defaults to `["message"]`) |
| `DELETE` | `/webhooks/:id` | — | Remove webhook |
| `POST` | `/stop` | — | Gracefully shut down the daemon |
| `POST` | `/logout` | — | Disconnect Baileys session + wipe `~/.wa/session/` |

### `/stop` Graceful Shutdown Sequence
1. Respond `200 OK` immediately
2. Close Baileys socket cleanly
3. Flush any pending SQLite writes
4. Delete `~/.wa/daemon.pid`
5. `process.exit(0)` after a 500ms drain

### `/logout` Sequence
1. Call Baileys `client.logout()` (signals device removal on WhatsApp servers)
2. Delete `~/.wa/session/`
3. Respond `200 OK`
4. Daemon enters `"logged_out"` state — remains running but disconnected
5. In `"logged_out"` state: `/status` returns `{ "state": "logged_out" }`; `/send` and `/send-group` return `503 Service Unavailable`; recovery is `wa stop` then `wa start`

### `/messages` Query Parameters
- `limit` — integer, default `20`, max `1000` (clamped silently)
- `from` — E.164 phone number (e.g. `+14155551234`); normalized to JID (`\d+@s.whatsapp.net`) by the API layer before querying
- `group` — group alias; resolved to JID via `groups` table join before querying (`chat_jid` filter)

### `/groups` Scope
Returns only manually registered aliases (added via `wa groups add` or `POST /groups`). These are a subset of all WhatsApp groups the account belongs to. Baileys `groupFetchAllParticipating()` is available but not exposed in this version (out of scope for v1).

---

## Database Schema

```sql
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT NOT NULL,
  sender_jid    TEXT NOT NULL,
  sender_name   TEXT,
  chat_jid      TEXT NOT NULL,
  chat_name     TEXT,
  text          TEXT,              -- NULL for non-text/media messages
  is_group      INTEGER NOT NULL DEFAULT 0,
  is_from_me    INTEGER NOT NULL DEFAULT 0,
  wa_message_id TEXT UNIQUE  -- deduplicates replayed messages on reconnect
);

CREATE TABLE groups (
  alias       TEXT PRIMARY KEY,
  jid         TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE webhooks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,  -- JSON array, e.g. ["message", "message.individual", "message.group"]
  created_at  TEXT NOT NULL
);
```

**Outbound messages** (sent via `/send` or `/send-group`) are stored with `is_from_me = 1`.

**Media messages** (images, audio, documents, stickers) are stored with `text = NULL`. No webhook is fired for media messages in v1 (declared out of scope).

---

## Webhook Dispatch

On every inbound **text** message, `webhooks.js` queries the webhooks table and fires a POST to each URL whose `events` array matches:

- `"message"` — fires for all messages
- `"message.individual"` — fires only for 1:1 messages
- `"message.group"` — fires only for group messages

**Payload** (all fields use JID format for consistency; `event` reflects the most specific type):
```json
{
  "event": "message.individual",
  "timestamp": "2026-03-13T15:00:00.000Z",
  "sender_jid": "14155551234@s.whatsapp.net",
  "sender_name": "John Doe",
  "chat_jid": "14155551234@s.whatsapp.net",
  "chat_name": "John Doe",
  "text": "Hello",
  "is_group": false
}
```

A webhook registered for `"message"` receives payloads with `event` set to either `"message.individual"` or `"message.group"` (never the generic `"message"`). The `events` filter controls which messages trigger the webhook; `event` in the payload always reports the specific type.

Failed webhook POSTs are logged to `~/.wa/daemon.log` but do not crash the daemon. No retry on failure (v1).

---

## CLI Commands

```bash
# Daemon lifecycle
wa start                            # Start daemon (QR if no session, then background)
wa stop                             # Stop daemon gracefully (POST /stop)
wa status                           # Show connection state, uptime, message count

# Messaging
wa send +14155551234 "Hello"
wa send-group friends "Hey everyone"   # alias or full JID

# Inbox
wa messages                            # Last 20 messages
wa messages --limit 50
wa messages --from +14155551234        # Filter by contact (E.164)
wa messages --group friends            # Filter by group alias

# Group management
wa groups                              # List configured aliases only
wa groups add <alias> <jid>
wa groups remove <alias>

# Webhook management
wa webhooks                            # List webhooks
wa webhooks add <url>                  # Register; defaults to events=["message"]
wa webhooks add <url> --events message.group,message.individual
wa webhooks remove <id>

# Session
wa logout                              # Disconnect + wipe session (POST /logout)
                                       # Next `wa start` will require QR scan
```

If the daemon is not running, all commands except `wa start` print:
```
Daemon is not running. Start it with: wa start
```

---

## Configuration (`~/.wa/config.json`)

Created with defaults on first start if absent. Malformed JSON causes daemon to exit with a clear error. **Configuration is read once at daemon startup; changes require a daemon restart.**

```json
{
  "port": 3721
}
```

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@whiskeysockets/baileys` | `^6.7` | WhatsApp multi-device protocol client |
| `express` | `^4.18` | HTTP server for the daemon API |
| `better-sqlite3` | `^9.4` | Synchronous SQLite driver |
| `qrcode-terminal` | `^0.12` | Render QR code in terminal |
| `axios` | `^1.6` | HTTP client for CLI → daemon calls and webhook dispatch |
| `commander` | `^12.0` | CLI argument parsing |
| `pino` | `^8.19` | Structured logging for daemon |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Daemon already running | `wa start` detects live PID → exits with message |
| Stale PID file | Delete stale file, start fresh |
| QR timeout (25s) | Daemon exits, parent reports error |
| Startup timeout (30s) | Parent reports "check logs", exits 1 |
| WhatsApp disconnection | Baileys auto-reconnects, daemon logs event |
| Webhook POST failure | Log to `~/.wa/daemon.log`, continue, no retry |
| Invalid phone (non-E.164) | `/send` returns 400 with validation message |
| Unknown group alias in `/send-group` | Returns 404; raw JID passthrough requires `\d+@g.us` format, else 400 |
| `config.json` malformed | Daemon exits with clear parse error |
| Media messages received | Stored with `text = NULL`, no webhook fired (v1) |

---

## Out of Scope (v1)

- Multiple WhatsApp accounts / multi-instance daemon
- Listing all WhatsApp groups (only manually registered aliases)
- Media message handling in webhooks
- Webhook retry on failure
- Log rotation (use external logrotate if needed)
- Read receipts / message status tracking
- `wa reply <message-id>`
- Web UI
