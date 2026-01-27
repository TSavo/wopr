---
name: wopr-channel-management
description: Build or manage WOPR channels in plugins. Use when registering ChannelAdapter instances, mapping channels to sessions, or reasoning about channel metadata and context flow between channels and sessions.
---

# WOPR Channel Management

Channels are external message sources/sinks (Discord, P2P, etc.) that map into sessions. Channel adapters live in plugins and provide context and send behavior.

## Quick workflow

1. Define a `ChannelRef` and `ChannelAdapter` in your plugin.
2. Register the adapter with `registerChannel` during plugin init.
3. Use `getChannelsForSession` to discover outbound routes.

## Progressive disclosure

- For the exact interfaces (`ChannelRef`, `ChannelAdapter`) and plugin context APIs, read `references/interfaces.md`.
- For middleware interplay and channel metadata on messages, read `references/middleware-notes.md`.
