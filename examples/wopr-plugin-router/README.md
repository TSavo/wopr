# WOPR Router Plugin (Example)

This example plugin shows how to build middleware that routes messages between channels and sessions.

## Config

Configure routes in the plugin config (stored at `plugins.data.router`):

```json
{
  "routes": [
    {
      "sourceSession": "support",
      "targetSessions": ["billing", "engineering"],
      "channelType": "discord"
    }
  ],
  "outgoingRoutes": [
    {
      "sourceSession": "support",
      "channelType": "discord"
    }
  ]
}
```

### CLI

```bash
wopr config set plugins.data.router '{"routes":[{"sourceSession":"support","targetSessions":["billing","engineering"],"channelType":"discord"}],"outgoingRoutes":[{"sourceSession":"support","channelType":"discord"}]}'
```

### API

```bash
curl -X PUT http://localhost:7437/config/plugins.data.router \
  -H "Content-Type: application/json" \
  -d '{"routes":[{"sourceSession":"support","targetSessions":["billing","engineering"],"channelType":"discord"}],"outgoingRoutes":[{"sourceSession":"support","channelType":"discord"}]}'
```

## Behavior

- Incoming routes fan out messages to additional sessions.
- Outgoing routes forward responses to matching channels.
