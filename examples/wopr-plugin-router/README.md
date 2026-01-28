# WOPR Router Plugin (Example)

This example plugin shows how to build middleware that routes messages between channels and sessions.

## Config

Configure routes in the plugin config:

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

## Behavior

- Incoming routes fan out messages to additional sessions.
- Outgoing routes forward responses to matching channels.

