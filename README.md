# WhatsApp Daemon

A Node.js WhatsApp daemon with a local HTTP API and CLI.

## Installation

```bash
cd /Users/thotas/Development/Claude/Whatsapp
npm install
npm link
```

## Starting the Daemon

```bash
wa start
```

On first run, a QR code will appear. Scan it with **WhatsApp > Linked Devices > Link a Device**.

Once connected, the daemon runs in the background.

## CLI Commands

```bash
# Daemon lifecycle
wa start          # Start daemon (shows QR if not linked)
wa stop           # Stop daemon gracefully
wa status         # Show connection state, uptime, message count

# Send messages
wa send +14155551234 "Hello world"
wa send-group friends "Hey everyone"

# Send media (images, videos, documents)
wa send-media friends /path/to/photo.jpg --caption "Check this out"
wa send-media +14155551234 /path/to/document.pdf

# View messages
wa messages                           # Last 20 messages
wa messages --limit 50                # More messages
wa messages --from +14155551234        # Filter by phone
wa messages --group friends           # Filter by group

# Manage groups
wa groups                             # List group aliases
wa groups add friends 123456789@g.us  # Add group alias
wa groups remove friends              # Remove alias

# Manage webhooks
wa webhooks                           # List webhooks
wa webhooks add https://example.com/hook
wa webhooks add https://example.com/hook --events message,message.group
wa webhooks remove 1

# Session
wa logout                             # Log out and wipe session
```

## Troubleshooting

### "Daemon is not running"
Run `wa start` to start the daemon.

### WhatsApp rate limit
If WhatsApp says "can't login now", wait a few hours and try again.

### Check daemon logs
```bash
tail -f ~/.wa/daemon.log
```

### QR code timeout
If you need more time to scan, start the daemon manually:
```bash
node daemon.js &
```
Then scan the QR within 25 seconds (or the process will exit).

## API

The daemon exposes a local HTTP API on `localhost:3721`.

```bash
curl http://127.0.0.1:3721/status
curl http://127.0.0.1:3721/messages
```

### Send Media

Send media (images, videos, documents) to individuals or groups:

```bash
# To a group alias
curl -X POST http://127.0.0.1:3721/send-media \
  -F "target=friends" \
  -F "media=@/path/to/photo.jpg" \
  -F "caption=Check this out"

# To a group JID
curl -X POST http://127.0.0.1:3721/send-media \
  -F "target=123456789@g.us" \
  -F "media=@/path/to/file.pdf"

# To a phone number
curl -X POST http://127.0.0.1:3721/send-media \
  -F "target=+14155551234" \
  -F "media=@/path/to/image.png"
```

The `target` parameter accepts a group alias, group JID (`123456@g.us`), or phone number in E.164 format.
