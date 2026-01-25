# WOPR Discord Plugin

Talk to your WOPR sessions via Discord, with pairing and access control.

## Features

- **User-initiated pairing** - Users request access, owner approves
- **Access control** - Block/grant per-user, per-session
- **Channel mapping** - Route Discord channels to WOPR sessions
- **Auto-create** - Automatically create sessions for new channels

## Installation

```bash
wopr plugin install github:wopr/wopr-plugin-discord
```

## Quick Start

```bash
# 1. Set up the bot
wopr discord auth

# 2. Restart daemon
wopr daemon stop && wopr daemon start

# 3. Invite bot to your server (URL shown after auth)

# 4. Set access policy to require pairing
wopr discord access paired
```

## How Pairing Works

1. **User @mentions the bot** in Discord
2. **Bot replies with a pairing code:**
   ```
   Hi Alice! I don't recognize you yet.

   Your pairing code is: ABCD1234

   Ask the owner to run: wopr discord pair approve ABCD1234
   ```
3. **User tells owner the code** (DM, text, whatever)
4. **Owner approves:**
   ```bash
   wopr discord pair approve ABCD1234
   ```
5. **User can now talk to the bot**

The approval automatically grants access to the session they tried to use.

## Access Policies

```bash
wopr discord access all      # Anyone can use (default)
wopr discord access paired   # Only approved users (recommended)
wopr discord access none     # Only explicitly granted users
```

## Pairing Commands

```bash
# List pending requests
wopr discord pair list

# Approve (grants access to the session they tried to use)
wopr discord pair approve ABCD1234

# Approve with extra sessions
wopr discord pair approve ABCD1234 mybot,helper

# Reject a request
wopr discord pair reject ABCD1234 "not authorized"

# View all requests (including approved/rejected)
wopr discord pair history
```

## User Management

```bash
# List paired users
wopr discord users

# Grant access directly (bypass pairing)
wopr discord grant 123456789 mybot,helper --name "Alice"

# Revoke access
wopr discord revoke 123456789 mybot    # Specific session
wopr discord revoke 123456789          # All sessions

# Block/unblock
wopr discord block 123456789 "spam"
wopr discord unblock 123456789
```

## Channel Mapping

```bash
# Map channel to session
wopr discord map 123456789 mybot

# Respond to ALL messages (not just @mentions)
wopr discord map 123456789 mybot --all

# Restrict to specific users in that channel
wopr discord map 123456789 mybot --users 111,222,333

# List mappings
wopr discord mappings

# Remove mapping
wopr discord unmap 123456789
```

### Auto-Create Mode

```bash
wopr discord auto on    # Unmapped channels get sessions automatically
wopr discord auto off   # Only mapped channels work
```

## Config File

Stored in `~/.wopr/plugins/discord/config.json`:

```json
{
  "token": "your-bot-token",
  "autoCreate": true,
  "defaultAccess": "paired",
  "mappings": {
    "123456789": {
      "session": "mybot",
      "respondToAll": false
    }
  },
  "users": {
    "372912494030749706": {
      "name": "Alice",
      "sessions": ["mybot"],
      "pairedAt": 1706123456789,
      "pairedWith": "ABCD1234"
    }
  },
  "pairingRequests": {
    "ABCD1234": {
      "userId": "372912494030749706",
      "userName": "Alice",
      "channelName": "general",
      "guildName": "My Server",
      "status": "approved",
      "createdAt": 1706123456789,
      "approvedAt": 1706123556789,
      "sessions": ["mybot"]
    }
  }
}
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `wopr discord auth` | Set up bot token |
| `wopr discord status` | Show connection status |
| `wopr discord access [policy]` | Set default access (all/paired/none) |
| `wopr discord pair list` | List pending pairing requests |
| `wopr discord pair approve <code> [sessions]` | Approve request |
| `wopr discord pair reject <code> [reason]` | Reject request |
| `wopr discord pair history` | Show all requests |
| `wopr discord users` | List paired users |
| `wopr discord grant <user> <sessions>` | Grant access |
| `wopr discord revoke <user> [sessions]` | Revoke access |
| `wopr discord block <user> [reason]` | Block user |
| `wopr discord unblock <user>` | Unblock user |
| `wopr discord map <channel> <session>` | Map channel |
| `wopr discord unmap <channel>` | Unmap channel |
| `wopr discord mappings` | List mappings |
| `wopr discord auto [on\|off]` | Auto-create mode |

## Troubleshooting

**Bot doesn't respond:**
- Check `wopr discord status`
- Is the daemon running? `wopr daemon status`
- Is the user paired? `wopr discord users`

**User gets pairing prompt every time:**
- Owner needs to approve: `wopr discord pair list` then `approve`

**"MESSAGE CONTENT INTENT" error:**
- Discord Developer Portal → Bot → Enable "MESSAGE CONTENT INTENT"
