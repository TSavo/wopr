# WOPR Plugins

WOPR's plugin system enables extending functionality through community and official plugins. Plugins can add channels (Discord, Telegram, etc.), providers (AI models), and middleware.

## Official Plugins

### Channel Plugins

Connect WOPR to external messaging platforms:

| Plugin | Platform | Status | Repository |
|--------|----------|--------|------------|
| `wopr-plugin-discord` | Discord | ✅ Ready | [TSavo/wopr-plugin-discord](https://github.com/TSavo/wopr-plugin-discord) |
| `wopr-plugin-slack` | Slack | ✅ Ready | [TSavo/wopr-plugin-slack](https://github.com/TSavo/wopr-plugin-slack) |
| `wopr-plugin-telegram` | Telegram | ✅ Ready | [TSavo/wopr-plugin-telegram](https://github.com/TSavo/wopr-plugin-telegram) |
| `wopr-plugin-whatsapp` | WhatsApp | ✅ Ready | [TSavo/wopr-plugin-whatsapp](https://github.com/TSavo/wopr-plugin-whatsapp) |
| `wopr-plugin-signal` | Signal | ✅ Ready | [TSavo/wopr-plugin-signal](https://github.com/TSavo/wopr-plugin-signal) |
| `wopr-plugin-imessage` | iMessage | ✅ Ready (macOS) | [TSavo/wopr-plugin-imessage](https://github.com/TSavo/wopr-plugin-imessage) |
| `wopr-plugin-msteams` | Microsoft Teams | ✅ Ready | [TSavo/wopr-plugin-msteams](https://github.com/TSavo/wopr-plugin-msteams) |

### Provider Plugins

AI model provider integrations:

| Plugin | Provider | Status | Repository |
|--------|----------|--------|------------|
| `wopr-plugin-provider-kimi` | Moonshot AI Kimi | ✅ Ready | [TSavo/wopr-plugin-provider-kimi](https://github.com/TSavo/wopr-plugin-provider-kimi) |
| `wopr-plugin-provider-openai` | OpenAI | ✅ Ready | [TSavo/wopr-plugin-provider-openai](https://github.com/TSavo/wopr-plugin-provider-openai) |
| `wopr-plugin-provider-anthropic` | Anthropic Claude | ✅ Ready | [TSavo/wopr-plugin-provider-anthropic](https://github.com/TSavo/wopr-plugin-provider-anthropic) |

### Utility Plugins

| Plugin | Purpose | Status | Repository |
|--------|---------|--------|------------|
| `wopr-plugin-router` | Message routing between sessions | 🔨 Planned | - |
| `wopr-plugin-memory` | Persistent memory across sessions | 🔨 Planned | - |

## Plugin Installation

```bash
# Install from GitHub
wopr plugin install github:TSavo/wopr-plugin-discord

# Enable the plugin
wopr plugin enable wopr-plugin-discord

# Configure the plugin
wopr config set plugins.data.wopr-plugin-discord '{"botToken": "...", "channelId": "..."}'

# List installed plugins
wopr plugin list

# Disable/remove
wopr plugin disable wopr-plugin-discord
wopr plugin uninstall wopr-plugin-discord
```

## Using the Onboarding Wizard

For easy setup of multiple plugins:

```bash
wopr onboard
```

This interactive wizard will:
1. Guide you through identity setup
2. Configure AI providers
3. Set up channel plugins (Discord, Slack, Telegram, etc.)
4. Configure P2P networking
5. Set up skills and middleware

## Plugin Development

### Basic Plugin Structure

```typescript
import type { WOPRPlugin, WOPRPluginContext } from "wopr";

const plugin: WOPRPlugin = {
  name: "my-plugin",
  version: "1.0.0",
  description: "My awesome plugin",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("Plugin initialized!");
    
    // Access configuration
    const config = ctx.getConfig();
    
    // Register a channel adapter
    ctx.registerChannel({
      channel: { type: "myplatform", id: "channel-id", name: "My Channel" },
      session: "default",
      async send(content) {
        // Send message to external platform
      },
      async start(handler) {
        // Start listening for messages
      },
      async stop() {
        // Stop listening
      },
    });
  },

  async destroy(ctx: WOPRPluginContext) {
    ctx.log.info("Plugin destroyed!");
  },
};

export default plugin;
```

### Plugin Context API

The `ctx` object provides:

**Session Management:**
- `ctx.inject(session, message, options)` - Get AI response
- `ctx.logMessage(session, message, options)` - Log without AI response
- `ctx.injectPeer(peer, session, message)` - Send to peer

**Configuration:**
- `ctx.getConfig()` - Get plugin config
- `ctx.saveConfig(config)` - Save plugin config
- `ctx.getMainConfig(key)` - Access main WOPR config

**Channels:**
- `ctx.registerChannel(adapter)` - Register a channel
- `ctx.unregisterChannel(channel)` - Unregister
- `ctx.getChannels()` - List all channels

**Events:**
- `ctx.events.on(event, handler)` - Subscribe to events
- `ctx.events.once(event, handler)` - Subscribe once
- `ctx.events.emit(event, payload)` - Emit custom events
- `ctx.hooks.on(event, handler)` - Mutable lifecycle hooks

See [Events Documentation](events.md) for details.

**Context Providers:**
- `ctx.registerContextProvider(provider)` - Add context sources
- `ctx.unregisterContextProvider(name)` - Remove

**Middleware:**
- `ctx.registerMiddleware(middleware)` - Register message middleware
- `ctx.getMiddlewares()` - List middlewares

**Web UI:**
- `ctx.registerWebUiExtension(extension)` - Add nav links
- `ctx.registerUiComponent(extension)` - Add SolidJS components

**Logging:**
- `ctx.log.info(message, ...args)`
- `ctx.log.warn(message, ...args)`
- `ctx.log.error(message, ...args)`
- `ctx.log.debug(message, ...args)`

### Plugin Configuration Schema

Define a UI for plugin configuration:

```typescript
ctx.registerConfigSchema("my-plugin", {
  title: "My Plugin Settings",
  description: "Configure my plugin",
  fields: [
    {
      name: "apiKey",
      type: "string",
      label: "API Key",
      secret: true,
      required: true,
    },
    {
      name: "enabled",
      type: "boolean",
      label: "Enabled",
      default: true,
    },
    {
      name: "mode",
      type: "select",
      label: "Mode",
      options: ["simple", "advanced"],
      default: "simple",
    },
  ],
});
```

### Plugin CLI Commands

Add commands to the WOPR CLI:

```typescript
const plugin: WOPRPlugin = {
  // ... init, destroy

  commands: {
    async status(ctx) {
      const config = ctx.getConfig();
      return `Plugin is ${config.enabled ? "enabled" : "disabled"}`;
    },

    async config(ctx, args) {
      if (args[0] === "set") {
        // Handle set command
        return "Config updated";
      }
      return JSON.stringify(ctx.getConfig(), null, 2);
    },
  },
};
```

Usage: `wopr plugin cmd my-plugin status`

### Building Reactive Plugins with Events

The event bus enables reactive plugin composition:

```typescript
async init(ctx) {
  // React to session lifecycle
  ctx.events.on("session:create", (event) => {
    ctx.log.info(`New session: ${event.session}`);
  });

  // React to messages
  ctx.events.on("session:beforeInject", (event) => {
    // Log, analyze, or modify
    analytics.track(event.session, event.message);
  });

  // Inter-plugin communication
  ctx.events.on("other-plugin:event", (event) => {
    // React to other plugins
  });

  // Emit custom events
  await ctx.events.emitCustom("myplugin:ready", { 
    timestamp: Date.now() 
  });
}
```

See [Events Documentation](events.md) for full details.

### Plugin Distribution

Publish your plugin:

1. Create a GitHub repository
2. Add a `package.json` with proper metadata
3. Tag releases with semantic versions
4. Users install: `wopr plugin install github:username/repo`

### Plugin Best Practices

1. **Use semantic versioning** - Follow semver for releases
2. **Handle errors gracefully** - Don't crash WOPR on errors
3. **Clean up in destroy** - Stop listeners, close connections
4. **Use config schemas** - Make configuration easy
5. **Document your plugin** - Clear README with examples
6. **Prefix custom events** - Use `pluginname:event` format
7. **Respect the event loop** - Don't block, use async

## Plugin Ecosystem

Contributions welcome! To add your plugin to the list:

1. Ensure it follows the plugin API
2. Has a clear README with setup instructions
3. Submit a PR to update this document

## Troubleshooting

### Plugin won't load

Check logs: `wopr daemon logs`

Common issues:
- Missing dependencies: `npm install` in plugin directory
- Syntax errors: Check TypeScript compilation
- Missing config: Use `wopr config set`

### Plugin conflicts

Plugins can conflict if they:
- Register the same channel ID
- Use conflicting middleware
- Override each other's config

Use descriptive names and check `wopr plugin list`.

### Debugging

Enable debug logging:

```bash
DEBUG=wopr:* wopr daemon start
```

Or in your plugin:

```typescript
ctx.log.debug("Debug info:", data);
```
