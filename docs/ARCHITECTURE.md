# WOPR Architecture

**Without Official Permission Required**

## Design Philosophy

WOPR is built on three principles:

1. **Plugin-first** - Core functionality is minimal; features are added through plugins
2. **AI-native** - AI agents are first-class citizens, not users
3. **Session-centric** - Sessions are the unit of memory and context

## System Overview

```
+-------------------------------------------------------------+
|                         WOPR                                |
+-------------------------------------------------------------+
|  CLI (wopr)                                                 |
|    +-- session management                                   |
|    +-- skill management                                     |
|    +-- cron scheduling                                      |
|    +-- provider management                                  |
|    +-- plugin commands                                      |
|    +-- security/sandbox management                          |
+-------------------------------------------------------------+
|  Daemon                                                     |
|    +-- HTTP API server                                      |
|    +-- Cron scheduler                                       |
|    +-- Session injection                                    |
|    +-- Plugin runtime                                       |
+-------------------------------------------------------------+
|  Plugin System                                              |
|    +-- Channel adapters (Discord, Slack, etc.)             |
|    +-- Model providers (Kimi, OpenAI, Anthropic)           |
|    +-- P2P networking (via wopr-plugin-p2p)                |
|    +-- Middleware (message transformation)                 |
|    +-- Event bus (reactive composition)                    |
+-------------------------------------------------------------+
|  Security Layer                                             |
|    +-- Trust levels (owner, trusted, semi-trusted, etc.)   |
|    +-- Capability-based access control                      |
|    +-- Rate limiting                                        |
|    +-- Docker sandbox isolation                             |
+-------------------------------------------------------------+
|  Context System                                             |
|    +-- Provider-based context assembly                      |
|    +-- Skills injection                                     |
|    +-- Workspace files (AGENTS.md, SOUL.md, USER.md)       |
+-------------------------------------------------------------+
```

## Session Model

Sessions are named AI conversations:

```
Session "dev"
+-- Context (dev.md)
|   "You are a senior developer..."
+-- Session ID (from AI provider)
|   "sess_abc123..."
+-- Provider
|   "anthropic" or "codex"
+-- Message History
    (managed by provider)
```

**Injection:** Messages are injected into sessions. The AI processes them with configured tools and context.

```bash
# Local injection (gets AI response)
wopr session inject dev "Review this code"

# Log context without AI response
wopr session log dev "User prefers TypeScript"
```

Inject gets an AI response; log adds to history without triggering AI (useful for context).

## Channel Model

Channels are how messages move in and out of WOPR. A channel is an external transport plus its
surrounding context (e.g., Discord channels, P2P friends, email threads). Channels provide:

- **Send/receive** primitives (how messages arrive and how responses are delivered).
- **Context** (recent history or metadata needed to ground the session).
- **Mapping** to a session (the session is the unit of agent-native memory).

```
Channel (discord:#dev)
+-- Transport (Discord API)
+-- Context (recent messages, participants)
+-- Session binding ("dev")
```

**Key separation:** Sessions are internal, agent-managed state. Channels are external interfaces that
surface messages and context. This separation allows the same session to be driven by multiple
channels (or to swap channels without changing session state).

Channels are implemented as plugins so transports like Discord, Slack, or P2P can be installed
independently without touching session logic.

Example mapping:

```
Discord channel #dev --+
Slack channel #general-+-> Session "dev"
Local CLI             -+
```

## Middleware Model

Middlewares are pluggable, stackable processors that sit between channels and sessions. They can
inspect, modify, or block incoming messages before they reach a session, and can also post-process
responses before they return to a channel (e.g., security filters, formatting, or routing logic).
Middleware implementations are installed as plugins and registered through the plugin context,
with configuration stored under `plugins.data.<pluginName>` in the central config.

```bash
# List middleware and their priority
wopr middleware list

# View execution chain
wopr middleware chain

# Enable/disable
wopr middleware enable my-filter
wopr middleware disable my-filter

# Set priority (lower = runs first)
wopr middleware priority my-filter 50
```

## Provider System

WOPR supports multiple AI providers:

```
Provider Registry
+-- anthropic (Claude) - API key, built-in
+-- codex (OpenAI Codex) - API key, built-in
+-- kimi (Moonshot AI) - OAuth, via plugin
+-- openai (GPT models) - API key, via plugin
+-- (more via plugins)
```

**Built-in providers:**
- `anthropic` - Claude models via Agent SDK
- `codex` - OpenAI Codex agent for coding tasks

**Auto-detection:** WOPR automatically uses the first available provider. No configuration needed if you have at least one provider set up.

**Provider plugins** register themselves at daemon startup and expose:
- Credential type (oauth, api-key, custom)
- Health check
- Client factory for queries

## Context Provider System

Context providers assemble context for AI sessions. They run in priority order and can inject:

- Workspace files (AGENTS.md, SOUL.md, USER.md)
- Installed skills
- Custom context from plugins

```bash
# List context providers
wopr context list

# Enable/disable
wopr context enable skills
wopr context disable workspace-files

# Set priority (lower = earlier in context)
wopr context priority skills 10
```

## Plugin System

WOPR supports TypeScript/JavaScript plugins for extending functionality:

### Plugin Types

1. **Provider plugins** - Add AI providers (Kimi, OpenAI, Anthropic, etc.)
2. **Channel plugins** - Add message transports (Discord, Slack, P2P, etc.)
3. **Middleware plugins** - Process/modify messages
4. **Context plugins** - Add custom context to sessions

### Plugin Lifecycle

```
1. Install: wopr plugin install <source>
   - Download from npm, GitHub, or local path
   - Extract to ~/wopr/plugins/<name>/

2. Enable: wopr plugin enable <name>
   - Add to plugins.json enabled list
   - Load on next daemon restart

3. Initialize (at daemon startup):
   - Call plugin.init(context)
   - Plugin registers handlers, commands, etc.

4. Shutdown (at daemon stop):
   - Call plugin.shutdown() if defined
   - Cleanup resources
```

### Plugin Context

Plugins receive a context object with:

```typescript
interface WOPRPluginContext {
  // Core functions
  inject(session, message, options)   // Get AI response
  logMessage(session, message, opts)  // Log without AI response

  // Sessions
  getSessions()
  getSession(name)
  createSession(name, context, provider)

  // Config
  getConfig()
  saveConfig(config)
  registerConfigSchema(pluginId, schema)

  // Events
  events: EventEmitter
  hooks: HookSystem

  // Logging
  log: Logger

  // Middleware
  registerMiddleware(name, handler, priority)

  // Context providers
  registerContextProvider(name, handler, priority)

  // Provider registration
  registerProvider(id, factory)
}
```

### Example: Channel Plugin

```typescript
export default {
  name: "wopr-plugin-discord",
  version: "2.1.0",

  async init(ctx) {
    // Register config schema for UI
    ctx.registerConfigSchema("wopr-plugin-discord", {
      title: "Discord Integration",
      fields: [
        { name: "token", type: "password", label: "Bot Token", required: true }
      ]
    });

    // Get config
    const config = ctx.getConfig();

    // Handle Discord messages
    client.on("messageCreate", async (msg) => {
      if (isMentioned) {
        // Get AI response
        const response = await ctx.inject(
          `discord-${msg.channel.id}`,
          msg.content,
          { from: msg.author.username }
        );
        await msg.reply(response);
      } else {
        // Just log for context
        ctx.logMessage(
          `discord-${msg.channel.id}`,
          msg.content,
          { from: msg.author.username }
        );
      }
    });
  }
};
```

## Event Bus

WOPR exposes a reactive event bus for plugin composition:

### Core Events

| Event | Description | Payload |
|-------|-------------|---------|
| `session:create` | Session created | `{ session, context, provider }` |
| `session:delete` | Session deleted | `{ session }` |
| `session:beforeInject` | Before AI query | `{ session, message, from }` |
| `session:afterInject` | After AI response | `{ session, message, response }` |
| `cron:trigger` | Cron job fired | `{ name, session, message }` |
| `plugin:load` | Plugin loaded | `{ name, version }` |
| `plugin:unload` | Plugin unloaded | `{ name }` |

### Hook System

Hooks allow plugins to modify data at key points:

```typescript
// Modify message before AI processing
ctx.hooks.on("message:incoming", async (event) => {
  event.data.message = `[${new Date().toISOString()}] ${event.data.message}`;
});

// Modify response before delivery
ctx.hooks.on("message:outgoing", async (event) => {
  event.data.response = filterProfanity(event.data.response);
});
```

## Daemon Architecture

```
+--------------------------------------------+
|                  Daemon                     |
+--------------------------------------------+
|  +------------------+  +----------------+  |
|  | HTTP API Server  |  | Plugin Runtime |  |
|  | (Express)        |  | (load/unload)  |  |
|  +--------+---------+  +-------+--------+  |
|           |                    |           |
|           v                    v           |
|  +--------------------------------------+  |
|  |         Request Handler              |  |
|  |  - Route to session                  |  |
|  |  - Execute middleware chain          |  |
|  |  - Apply security checks             |  |
|  +------------------+-------------------+  |
|                     |                      |
|                     v                      |
|  +--------------------------------------+  |
|  |         Session Injector             |  |
|  |  - Assemble context                  |  |
|  |  - Call AI provider                  |  |
|  |  - Handle streaming                  |  |
|  +--------------------------------------+  |
|                                            |
|  +--------------------------------------+  |
|  |         Cron Scheduler               |  |
|  |  - Check schedules every 30s         |  |
|  |  - Trigger injections                |  |
|  +--------------------------------------+  |
+--------------------------------------------+
```

## Security Architecture

WOPR implements a three-layer security model:

### 1. Trust Levels

| Level | Description | Default Capabilities |
|-------|-------------|---------------------|
| `owner` | Full access | All capabilities |
| `trusted` | Elevated access | Most capabilities |
| `semi-trusted` | Limited access | Safe operations |
| `untrusted` | Minimal access | Read-only, rate-limited |

### 2. Capabilities

Fine-grained permissions that can be granted or denied:

- `session:create` - Create new sessions
- `session:inject` - Inject messages
- `session:delete` - Delete sessions
- `cron:manage` - Create/delete cron jobs
- `plugin:manage` - Install/remove plugins
- `sandbox:execute` - Run sandboxed code
- `*` - All capabilities

### 3. Sandbox Isolation

Docker-based execution isolation for untrusted code:

```bash
# Create sandbox for session
wopr sandbox create mysession

# Run code in sandbox
wopr sandbox exec mysession "ls -la"

# Check sandbox status
wopr sandbox status
```

See [Security documentation](SECURITY.md) for full details.

## P2P Architecture (Plugin)

P2P functionality is provided by the `wopr-plugin-p2p` plugin. When installed, it adds:

### Identity Model

Every P2P-enabled WOPR instance has a cryptographic identity:

```
Identity
+-- Signing (Ed25519)
|   +-- publicKey   - Your identity, shareable
|   +-- privateKey  - Never leaves your machine
+-- Encryption (X25519)
    +-- encryptPub  - For others to encrypt to you
    +-- encryptPriv - To decrypt messages for you
```

### Trust Model

Trust is explicit, bilateral, and revocable through invites:

```
Alice                                    Bob
  |                                       |
  |  1. Alice knows Bob's pubkey          |
  |                                       |
  |  2. Alice creates invite              |
  |     +---------------------+           |
  |     | iss: Alice.pubkey   |           |
  |     | sub: Bob.pubkey     | ----------+---> Only Bob can claim
  |     | ses: ["help"]       |           |
  |     | sig: Alice.sign()   |           |
  |     +---------------------+           |
  |                                       |
  |  3. Bob claims invite (P2P)           |
  |     - Proves he owns sub pubkey       |
  |     - Handshake exchanges encrypt keys|
  |                                       |
  |  4. Both store grants                 |
  |     Alice: Bob can inject to "help"   |
  |     Bob: Alice is a peer              |
```

### Connection Flow

Built on Hyperswarm DHT for peer discovery and connection:

```
Alice                              DHT                              Bob
  |                                 |                                |
  |  1. Alice wants to reach Bob    |                                |
  |                                 |                                |
  |-- lookup(hash(Bob.pubkey)) ---->|                                |
  |                                 |<---- announce(hash(pubkey)) ---|
  |<-- peer info -------------------|                                |
  |                                 |                                |
  |  2. Direct connection           |                                |
  |-------------------------------------------------------------------->|
  |                                 |                                |
  |  3. Protocol handshake          |                                |
  |-- Hello {versions, ephemeral} ------------------------------------->|
  |<- HelloAck {version, ephemeral} ------------------------------------|
  |                                 |                                |
  |  4. Encrypted communication     |                                |
  |-- [AES-256-GCM encrypted msg] ------------------------------------->|
```

See [Protocol documentation](PROTOCOL.md) and [Discovery documentation](DISCOVERY.md) for details.

## File Structure

```
~/wopr/
+-- config.json       # Main configuration
+-- sessions.json     # Session ID mappings
+-- sessions/         # Session context files
|   +-- mybot.md
+-- skills/           # Installed skills
|   +-- code-review/
|       +-- SKILL.md
+-- plugins/          # Installed plugins
|   +-- wopr-plugin-discord/
+-- plugins.json      # Plugin registry
+-- crons.json        # Scheduled jobs
+-- registries.json   # Skill registries
+-- security.json     # Security configuration
+-- daemon.pid        # Daemon process ID
+-- daemon.log        # Daemon logs
```

## Configuration

See [Configuration documentation](CONFIGURATION.md) for complete reference.
