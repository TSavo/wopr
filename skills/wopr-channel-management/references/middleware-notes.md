# Channel Metadata in Middleware

Middleware hooks receive optional channel metadata so they can route or filter messages:

- Incoming middleware receives `{ session, from, message, channel? }`.
- Outgoing middleware receives `{ session, from, response, channel? }`.

When present, `channel` is the `ChannelRef` registered by the channel adapter.
