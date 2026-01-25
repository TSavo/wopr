# Architecture

**Analysis Date:** 2026-01-25

## Pattern Overview

**Overall:** Client-Server with Pluggable P2P and Daemon-based Task Scheduler

WOPR is a self-sovereign AI session management system built around a background daemon that coordinates all functionality. The architecture separates concerns into thin CLI client, HTTP daemon server with WebSocket support, core business logic, cryptographic identity/trust layer, and extensible plugin system.

**Key Characteristics:**
- **Daemon-centric**: All functionality runs through a background HTTP daemon (port 7437)
- **CLI-as-thin-client**: Command-line interface is a thin HTTP client with no business logic
- **Plugin architecture**: Extensible hooks for both runtime behavior and CLI commands
- **P2P-ready**: Built-in Hyperswarm integration for peer-to-peer message passing
- **Cryptographic trust**: Ed25519 signing, X25519 encryption, key rotation with grace periods
- **Session-oriented**: Named conversational sessions with persistent context and history

## Layers

**CLI Layer:**
- Purpose: Command-line interface and user interaction
- Location: `src/cli.ts`
- Contains: Command parsing, help text, daemon lifecycle management (start/stop/status)
- Depends on: HTTP client (`WoprClient`), core paths, auth utilities
- Used by: Users invoking `wopr` commands

**HTTP API Layer (Daemon):**
- Purpose: REST API server providing all WOPR functionality
- Location: `src/daemon/index.ts` (creates Hono app)
- Contains: Route mounting, Hono middleware (CORS, logging), WebSocket setup
- Depends on: Hono framework, route handlers, core modules
- Used by: CLI client, web UI, external API consumers

**Route Handlers Layer:**
- Purpose: HTTP endpoint implementations for specific features
- Location: `src/daemon/routes/*.ts` (10 routers: auth, config, sessions, crons, peers, plugins, skills, identity, discover, and index)
- Contains: Endpoint definitions, request/response handling, validation
- Depends on: Hono, core modules for business logic
- Used by: Hono app during request routing

**Core Business Logic Layer:**
- Purpose: Session management, skill discovery, cron scheduling, configuration
- Location: `src/core/*.ts` (sessions, skills, cron, config, registries)
- Contains: Data persistence, scheduling logic, session lifecycle
- Depends on: File system, identity module, types
- Used by: Route handlers, daemon initialization

**Cryptographic & Identity Layer:**
- Purpose: Cryptographic operations, identity management, trust and authorization
- Location: `src/identity.ts`, `src/trust.ts`, `src/rate-limit.ts`
- Contains: Ed25519/X25519 key generation, message signing/verification, ephemeral keys, rate limiting
- Depends on: Node.js crypto module, types
- Used by: P2P layer, discovery, CLI auth commands

**P2P & Discovery Layer:**
- Purpose: Peer-to-peer messaging, topic-based discovery, connection establishment
- Location: `src/p2p.ts`, `src/discovery.ts`
- Contains: Hyperswarm integration, message protocol handling, profile management
- Depends on: Hyperswarm, identity layer, trust layer, rate limiting
- Used by: Daemon event loop, discovery endpoints

**Plugin System:**
- Purpose: Extensibility for runtime behavior and CLI commands
- Location: `src/plugins.ts`
- Contains: Plugin loading, context provision, event emission, command registration
- Depends on: File system, event emitter, core modules
- Used by: Daemon during initialization and message injection

**Web UI Layer:**
- Purpose: Browser-based user interface
- Location: `web/src/` (Solid.js + Vite)
- Contains: React-like components, Settings panel, API client
- Depends on: Solid.js framework, Tailwind CSS, daemon HTTP API
- Used by: Browsers connecting to daemon

**Utilities:**
- Location: `src/paths.ts`, `src/types.ts`, `src/auth.ts`, `src/client.ts`, `src/rate-limit.ts`
- Purpose: Shared path definitions, type definitions, OAuth/API key auth, HTTP client

## Data Flow

**Session Injection (User → Claude → Response):**

1. User runs `wopr session inject <name> <message>`
2. CLI calls `WoprClient.inject()` → HTTP POST `/sessions/<name>/inject`
3. Route handler in `src/daemon/routes/sessions.ts` receives request
4. Handler calls `inject()` from `src/core/sessions.ts`
5. `inject()` calls Claude Agent SDK with session context + skills as XML
6. Claude streams response back through `StreamCallback`
7. Route handler emits WebSocket broadcast to subscribed clients (via `broadcastStream()`)
8. CLI displays streaming text, tool use, completion messages
9. Conversation logged to `~/.wopr/sessions/<name>.conversation.jsonl`

**P2P Message Flow (Peer A → Peer B):**

1. User runs `wopr inject <peer>:<session> <message>`
2. CLI calls `WoprClient.injectPeer()` → HTTP POST `/peers/<peer>/inject`
3. Daemon route handler calls `sendP2PInject()` from `src/p2p.ts`
4. P2P layer:
   - Looks up peer's connection via Hyperswarm discovery
   - Performs version handshake (negotiate protocol version)
   - Generates ephemeral X25519 key pair for forward secrecy
   - Encrypts message with X25519 ECDH + AES-256-GCM
   - Signs entire packet with Ed25519 private key
   - Sends to peer over socket
5. Receiving peer:
   - Verifies signature with sender's public key
   - Checks rate limits and replay nonces
   - Decrypts message using ephemeral key + own private key
   - Looks up authorization (access grant) for sender
   - Injects message into remote session if authorized
   - Returns response back through same encrypted channel

**Discovery Flow (Finding Peers):**

1. User runs `wopr discover join <topic>`
2. Daemon calls `joinTopic()` from `src/discovery.ts`
3. Discovery module:
   - Hashes topic string → SHA256 digest for Hyperswarm
   - Creates topic subscription in Hyperswarm
   - Broadcasts own profile (Ed25519 pubkey, current profile content)
   - Receives peer profiles from others in same topic
4. When peer appears:
   - User can call `wopr discover connect <peer-id>`
   - System sends connection request (discovery message)
   - Peer's AI decides (via plugin hook) to accept/reject
   - On acceptance: creates AccessGrant linking peer to sessions

**Cron Execution Flow:**

1. Daemon loads crons from `~/.wopr/crons.json` at startup
2. Main daemon loop (in `startDaemon()`) checks `shouldRunCron()` periodically
3. When scheduled time arrives:
   - Daemon calls `inject(sessionName, message)`
   - Works identically to session injection flow
   - Updates cron's `runAt` if recurring

**State Management:**

- **Sessions**: Stored as `{name → sessionId}` mapping in `~/.wopr/sessions.json` + `~/.wopr/sessions/<name>.md` context files
- **Conversation logs**: Persisted as JSONL (`~/.wopr/sessions/<name>.conversation.jsonl`) with one JSON entry per line
- **Crons**: Stored in `~/.wopr/crons.json`, loaded into memory, checked periodically
- **Peers**: Stored in `~/.wopr/peers.json` with Ed25519 pubkey, X25519 encrypt pubkey, and sessions list
- **Access grants**: Stored in `~/.wopr/access.json` (who can inject to MY sessions)
- **Identity**: Stored in `~/.wopr/identity.json` with Ed25519 and X25519 keypairs
- **Config**: Stored in `~/.wopr/config.json`, loaded once at daemon startup
- **Plugins**: Loaded from `~/.wopr/plugins/` directory, context stored in memory

## Key Abstractions

**Session (Conversational Context):**
- Purpose: Named container for conversation with Claude
- Examples: `src/core/sessions.ts` (Session interface), `src/daemon/routes/sessions.ts` (handlers)
- Pattern: Sessions are identified by name, backed by context markdown file + conversation JSONL log. Each session maps to a Claude Agent SDK thread (tracked via sessionId).

**CronJob (Scheduled Injection):**
- Purpose: Recurring or one-time message injection into session
- Examples: `src/core/cron.ts`, `src/daemon/routes/crons.ts`
- Pattern: Stored as JSON objects with schedule (cron expression or "once"), parsed at runtime, triggered by daemon loop

**Identity (Cryptographic Self):**
- Purpose: Self-sovereign identity based on Ed25519 keypair
- Examples: `src/identity.ts`, `src/types.ts` (Identity interface)
- Pattern: Single persistent Ed25519 key pair for signing, X25519 pair for encryption, stored in `identity.json` with optional rotation tracking

**AccessGrant (Authorization):**
- Purpose: Permission record allowing a peer to inject into specific sessions
- Examples: `src/trust.ts`, `src/types.ts` (AccessGrant interface)
- Pattern: Grants link peer's Ed25519 public key to a list of session names. Checked during P2P injection. Can be revoked.

**Profile (Discovery Identity):**
- Purpose: Broadcast-able self-description for peer discovery
- Examples: `src/discovery.ts`, `src/types.ts` (Profile interface)
- Pattern: Freeform JSON content (decided by AI), signed with Ed25519, includes topics, updated timestamp

**Skill (Claude Enhancement):**
- Purpose: Markdown file providing Claude with capabilities/tools
- Examples: `src/core/skills.ts`, `skills/` directory
- Pattern: Files at `~/.wopr/skills/<name>/SKILL.md` with YAML frontmatter (name, description), content converted to XML and passed to Claude in system prompt

**Plugin (Runtime Extension):**
- Purpose: Loadable Node.js module extending daemon behavior
- Examples: `src/plugins.ts`, `src/types.ts` (WOPRPlugin interface)
- Pattern: Plugin exports object with `init()`, `shutdown()`, `commands[]`. Receives `WOPRPluginContext` with hooks to inject, emit events, read config. Can provide context for sessions.

**WoprClient (HTTP Client):**
- Purpose: Thin wrapper for CLI → daemon communication
- Examples: `src/client.ts`
- Pattern: Translates method calls into HTTP requests to daemon at `http://127.0.0.1:7437`

## Entry Points

**CLI Entry (`wopr` command):**
- Location: `src/cli.ts`
- Triggers: User invokes `wopr` command from shell
- Responsibilities: Parse command-line arguments, dispatch to appropriate handler, display output. Most handlers call daemon via HTTP client. Config/auth don't require daemon.

**Daemon Entry (`wopr daemon start`):**
- Location: `src/daemon/index.ts` → `startDaemon()`
- Triggers: User runs `wopr daemon start` or daemon process started via `nohup`
- Responsibilities: Start Hono HTTP server, mount routes, setup WebSocket, initialize discovery, load plugins, start cron checker loop, write PID file

**Plugin Initialization:**
- Location: `src/plugins.ts` → `loadAllPlugins()`
- Triggers: Daemon startup
- Responsibilities: Load plugin files from `~/.wopr/plugins/`, call each plugin's `init()` with WoprPluginContext, register command handlers, register event listeners

**Web Server Entry:**
- Location: `web/src/index.tsx`
- Triggers: Browser request to daemon (if serving web UI)
- Responsibilities: Render Solid.js app, connect to WebSocket for streaming, display session UI

## Error Handling

**Strategy:** Exit codes, HTTP error responses, logged errors

**Patterns:**

- **P2P Errors**: Return exit codes (EXIT_OFFLINE, EXIT_REJECTED, EXIT_RATE_LIMITED, EXIT_VERSION_MISMATCH). CLI prints error message and exits with code.
- **HTTP Errors**: Route handlers return error JSON with status codes (400, 404, 500). Client wraps response in try/catch, throws on non-OK.
- **Cron Errors**: Logged to daemon log, cron continues running
- **Plugin Errors**: `try/catch` in plugin load, logged, plugin skipped
- **Daemon Errors**: Logged to `~/.wopr/daemon.log` file

## Cross-Cutting Concerns

**Logging:** `daemonLog()` writes to `~/.wopr/daemon.log`. Hono middleware logs HTTP requests.

**Validation:** Route handlers validate request body (`if (!name) return error`). Types are enforced at TypeScript compile time.

**Authentication:** OAuth via Anthropic (Claude Max/Pro) or API key. Stored in `~/.wopr/auth.json`. Loaded when injecting into Claude.

**Authorization:** Access grants checked during P2P injection. If peer's pubkey not in access grant for session, injection rejected.

**Rate Limiting:** `src/rate-limit.ts` enforces limits per IP/peer for connections, claims, injects. Uses sliding window with timestamps.

**Encryption:** X25519 ECDH for symmetric key derivation, AES-256-GCM for encryption, Ed25519 for signing. Ephemeral keys rotate per-connection for forward secrecy.

---

*Architecture analysis: 2026-01-25*
