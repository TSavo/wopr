# WOPR Examples

This directory contains example plugins and configurations demonstrating WOPR features.

## Plugin Examples

Located in `examples/plugins/`:

### Event Monitor Plugin (`event-monitor.ts`)

A comprehensive example demonstrating the event bus API.

**Features:**
- Subscribes to all core lifecycle events
- Demonstrates `ctx.events.on()`, `ctx.events.once()`, wildcard events
- Shows mutable hooks with `ctx.hooks.on()`
- Custom inter-plugin event emission
- Event listener management and cleanup

**Usage:**
```bash
# Copy to your plugins directory
cp examples/plugins/event-monitor.ts ~/.wopr/plugins/

# Enable
wopr plugin enable event-monitor
```

**Learn:** Event bus, hooks, reactive patterns, cleanup

---

### Session Analytics Plugin (`session-analytics.ts`)

Demonstrates building reactive stateful systems on top of events.

**Features:**
- Reactive state aggregation using events
- Tracks session metrics (message count, latency)
- Periodic reporting with setInterval
- Custom milestone events
- CLI commands for stats

**Usage:**
```bash
cp examples/plugins/session-analytics.ts ~/.wopr/plugins/
wopr plugin enable session-analytics

# View stats
wopr plugin cmd session-analytics stats
```

**Learn:** Stateful plugins, reactive patterns, CLI commands, analytics

---

## Creating Your Own Plugin

### Basic Template

```typescript
import type { WOPRPlugin, WOPRPluginContext } from "wopr";

const plugin: WOPRPlugin = {
  name: "my-plugin",
  version: "1.0.0",
  description: "My plugin description",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Plugin initialized!");
    
    // Your initialization code
  },

  async destroy(ctx: WOPRPluginContext) {
    ctx.log.info("Plugin destroyed!");
    
    // Cleanup code
  },
};

export default plugin;
```

### File Structure

```
my-plugin/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── README.md
```

### package.json

```json
{
  "name": "wopr-plugin-my-plugin",
  "version": "1.0.0",
  "description": "My WOPR plugin",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "peerDependencies": {
    "wopr": "^1.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true
  }
}
```

## Common Patterns

### Channel Adapter

```typescript
ctx.registerChannel({
  channel: { type: "myplatform", id: "channel-id" },
  session: "default",
  
  async send(content) {
    // Send to external platform
    await platform.sendMessage(content);
  },
  
  async start(handler) {
    // Start listening
    this.unsubscribe = platform.onMessage((msg) => {
      handler({
        text: msg.content,
        from: msg.author,
        channel: { type: "myplatform", id: msg.channelId },
      });
    });
  },
  
  async stop() {
    // Cleanup
    this.unsubscribe?.();
  },
});
```

### Event Handler

```typescript
// Subscribe to events
const unsub = ctx.events.on("session:beforeInject", (event) => {
  ctx.log.info(`Message: ${event.message}`);
});

// Store for cleanup
(ctx.config as any).unsub = unsub;
```

### Middleware

```typescript
ctx.registerMiddleware({
  name: "my-filter",
  priority: 100,
  direction: "incoming",
  
  async process(message, context) {
    // Block spam
    if (isSpam(message)) {
      return null; // Block message
    }
    
    // Transform message
    return message.toUpperCase();
  },
});
```

### Configuration Schema

```typescript
ctx.registerConfigSchema("my-plugin", {
  title: "My Plugin",
  fields: [
    {
      name: "apiKey",
      type: "string",
      label: "API Key",
      secret: true,
      required: true,
    },
  ],
});

// Use config
const config = ctx.getConfig();
```

## Testing Plugins

### Local Testing

```bash
# Create symlink
ln -s $(pwd)/my-plugin ~/.wopr/plugins/my-plugin

# Enable
wopr plugin enable my-plugin

# Watch logs
wopr daemon logs --follow
```

### Debug Mode

```typescript
// Add debug logging
ctx.log.debug("Debug info:", data);

// Or use console for quick debugging
console.log("Debug:", data);
```

## Publishing Plugins

1. **Create GitHub repository**
2. **Add README** with setup instructions
3. **Tag releases** with semantic versions
4. **Test thoroughly**
5. **Submit to awesome-wopr list**

## More Resources

- [Plugin Development Guide](../docs/PLUGINS.md)
- [Event Bus Documentation](../docs/events.md)
- [API Reference](../docs/API.md)
- [Official Plugins](https://github.com/TSavo?q=wopr-plugin)

## Contributing Examples

Have a useful example? Submit a PR!

Requirements:
- Clear documentation
- Working code
- Educational value
- Follows best practices
