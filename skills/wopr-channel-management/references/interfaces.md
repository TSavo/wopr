# Channel Interfaces and Plugin Context APIs

## ChannelRef
A channel identifier includes:

- `id`: Channel identifier (example: Discord channel ID)
- `type`: Channel type (example: `discord`, `p2p`)
- `name` (optional): Human-friendly label

## ChannelAdapter
A channel adapter maps a channel to a session and exposes:

- `channel`: the `ChannelRef`
- `session`: the session name
- `getContext()` to provide session context from the channel
- `send(message)` to deliver responses back to the channel

## Plugin context APIs
Plugins register and query channels through these methods:

- `registerChannel(adapter)`
- `unregisterChannel(channel)`
- `getChannel(channel)`
- `getChannels()`
- `getChannelsForSession(session)`
