# WOPR Event Bus

The WOPR Event Bus is a reactive primitive that enables plugins to communicate, react to lifecycle events, and build sophisticated behaviors through composition.

## Philosophy

**The WOPR way: Expose primitives, let plugins compose.**

Rather than baking in complex behaviors, WOPR provides simple event primitives that plugins use to build their own reactive systems.

## Quick Start

```typescript
import type { WOPRPlugin, WOPRPluginContext } from "wopr";

const plugin: WOPRPlugin = {
  name: "my-plugin",
  version: "1.0.0",

  async init(ctx: WOPRPluginContext) {
    // Listen to session creation
    ctx.events.on("session:create", (event) => {
      ctx.log.info(`Session created: ${event.session}`);
    });

    // Listen to message injection
    ctx.events.on("session:beforeInject", (event) => {
      ctx.log.info(`Message in ${event.session}: ${event.message}`);
    });
  },
};

export default plugin;
```

## Event Bus API

### `ctx.events.on(event, handler)`

Subscribe to an event. Returns an unsubscribe function.

```typescript
const unsub = ctx.events.on("session:create", (event) => {
  // Handle event
});

// Later: unsubscribe
unsub();
```

### `ctx.events.once(event, handler)`

Subscribe once - handler is removed after first event.

```typescript
ctx.events.once("session:create", (event) => {
  // Only fires for the first session
});
```

### `ctx.events.off(event, handler)`

Unsubscribe a specific handler.

```typescript
const handler = (event) => { /* ... */ };
ctx.events.on("session:create", handler);
ctx.events.off("session:create", handler);
```

### `ctx.events.emit(event, payload)`

Emit an event (typically for custom inter-plugin events).

```typescript
await ctx.events.emit("myplugin:custom", { data: "value" });
```

### `ctx.events.emitCustom(event, payload)`

Emit a custom event. Use `plugin:` prefix convention.

```typescript
await ctx.events.emitCustom("myplugin:notification", {
  title: "Hello",
  message: "World",
});
```

### `ctx.events.listenerCount(event)`

Get number of listeners for an event.

```typescript
const count = ctx.events.listenerCount("session:create");
```

## Hooks API

Hooks provide typed, mutable access to core lifecycle events:

```typescript
// beforeInject: Can modify message
ctx.hooks.on("session:beforeInject", async (event) => {
  // Access and modify data
  event.data.message = event.data.message.toUpperCase();
  
  // Prevent further processing
  if (event.data.message.includes("spam")) {
    event.preventDefault();
  }
});

// afterInject: Read-only access
ctx.hooks.on("session:afterInject", (event) => {
  // Cannot modify - just observe
  analytics.track(event.session, event.response.length);
});
```

## Core Events

### Session Lifecycle

| Event | Payload | Description |
|-------|---------|-------------|
| `session:create` | `{ session: string, config?: any }` | New session created |
| `session:beforeInject` | `{ session, message, from, channel? }` | Before message injection (mutable) |
| `session:afterInject` | `{ session, message, response, from }` | After response complete |
| `session:responseChunk` | `{ session, message, response, from, chunk }` | Each streaming chunk |
| `session:destroy` | `{ session, history, reason? }` | Session destroyed |

### Channel Events

| Event | Payload | Description |
|-------|---------|-------------|
| `channel:message` | `{ channel, message, from, metadata? }` | Message received from channel |
| `channel:send` | `{ channel, content }` | Message sent to channel |

### Plugin Lifecycle

| Event | Payload | Description |
|-------|---------|-------------|
| `plugin:beforeInit` | `{ plugin, version }` | Before plugin init |
| `plugin:afterInit` | `{ plugin, version }` | After plugin init |
| `plugin:error` | `{ plugin, error, context? }` | Plugin error occurred |

### System Events

| Event | Payload | Description |
|-------|---------|-------------|
| `config:change` | `{ key, oldValue, newValue, plugin? }` | Configuration changed |
| `system:shutdown` | `{ reason, code? }` | System shutting down |

### Wildcard

| Event | Payload | Description |
|-------|---------|-------------|
| `*` | `WOPREvent` | Catch all events |

## Building Reactive Systems

### Pattern: State Aggregation

```typescript
const state = new Map();

ctx.events.on("session:create", (e) => {
  state.set(e.session, { created: Date.now(), messages: 0 });
});

ctx.events.on("session:afterInject", (e) => {
  const s = state.get(e.session);
  if (s) s.messages++;
});

ctx.events.on("session:destroy", (e) => {
  state.delete(e.session);
});
```

### Pattern: Cross-Plugin Communication

```typescript
// Plugin A emits
await ctx.events.emitCustom("pluginA:analysisComplete", { result });

// Plugin B listens
ctx.events.on("pluginA:analysisComplete", (event) => {
  // Use the result
});
```

### Pattern: Middleware via Hooks

```typescript
ctx.hooks.on("session:beforeInject", async (event) => {
  // Add context prefix
  event.data.message = `[${new Date().toISOString()}] ${event.data.message}`;
  
  // Or block messages
  if (isBlocked(event.data.from)) {
    event.preventDefault();
  }
});
```

## Event Payload Types

```typescript
interface SessionCreateEvent {
  session: string;
  config?: any;
}

interface SessionInjectEvent {
  session: string;
  message: string;
  from: string;
  channel?: { type: string; id: string; name?: string };
}

interface SessionResponseEvent {
  session: string;
  message: string;
  response: string;
  from: string;
}

interface SessionResponseChunkEvent extends SessionResponseEvent {
  chunk: string;
}

interface SessionDestroyEvent {
  session: string;
  history: any[];
  reason?: string;
}

interface ChannelMessageEvent {
  channel: { type: string; id: string; name?: string };
  message: string;
  from: string;
  metadata?: any;
}

interface ChannelSendEvent {
  channel: { type: string; id: string };
  content: string;
}

interface PluginInitEvent {
  plugin: string;
  version: string;
}

interface PluginErrorEvent {
  plugin: string;
  error: Error;
  context?: string;
}

interface ConfigChangeEvent {
  key: string;
  oldValue: any;
  newValue: any;
  plugin?: string;
}

interface SystemShutdownEvent {
  reason: string;
  code?: number;
}
```

## Best Practices

1. **Use `plugin:` prefix** for custom events to avoid collisions
2. **Unsubscribe on destroy** to prevent memory leaks
3. **Handle errors** - async handlers should catch their own errors
4. **Keep handlers fast** - slow handlers block event propagation
5. **Use hooks for mutation**, events for observation
6. **Document custom events** your plugin emits

## Examples

See `examples/plugins/` for complete working examples:

- `event-monitor.ts` - Basic event monitoring
- `session-analytics.ts` - Reactive state building with analytics
