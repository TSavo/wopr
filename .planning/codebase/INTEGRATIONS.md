# External Integrations

**Analysis Date:** 2026-01-25

## APIs & External Services

**Anthropic Claude:**
- Service: Claude AI conversation API
- What it's used for: Core inference, session management, tool use, multi-turn conversations
- SDK/Client: @anthropic-ai/claude-agent-sdk 0.2.12
- Auth: ANTHROPIC_API_KEY (environment variable) or OAuth tokens from Claude Max/Pro subscription
- Location: `src/core/sessions.ts` uses `query()` function for streaming conversations
- Endpoints: Anthropic API endpoints (configured in SDK, not exposed in code)

**GitHub API:**
- Service: Skill registry repository access and search
- What it's used for: Discovering and installing skills from GitHub repositories
- SDK/Client: Native fetch() with GitHub API REST endpoints
- Auth: GITHUB_TOKEN (optional environment variable, used for API rate limiting)
- Location: `src/core/registries.ts` with `fetchGitHubSkills()` function
- Rate limits: Applied per GitHub API limits; token increases limits
- Endpoints: https://api.github.com/repos, /contents, /search

**npm Registry:**
- Service: Package search for plugins
- What it's used for: Searching npm packages with "wopr-plugin-" prefix
- SDK/Client: Native fetch() against npm registry
- Location: `src/cli.ts` (plugin search command)
- Endpoints: https://registry.npmjs.org (implied via package name search)

## Authentication & Identity

**Auth Provider:**
- Type: Dual-mode authentication
  - OAuth (Claude Max/Pro subscription via claude.ai)
  - API Key (pay-per-use)

**OAuth Implementation:**
- Flow: PKCE-based authorization code flow (RFC 7636)
- Client ID: 9d1c250a-e61b-44d9-88ed-5944d1962f5e (hardcoded in `src/auth.ts`)
- Auth URL: https://claude.ai/oauth/authorize
- Token URL: https://console.anthropic.com/v1/oauth/token
- Redirect URI: http://localhost:9876/callback (for login command)
- Scopes: org:create_api_key, user:profile, user:inference
- Token Storage: `~/.wopr/auth.json` (mode 0600 when created, not enforced)
- Auto-detect: Checks `~/.claude/.credentials.json` first (Claude Code shared credentials)
- Refresh: Automatic token refresh with 5-minute expiration buffer
- Location: `src/auth.ts`

**API Key Mode:**
- Storage: Plain text in `~/.wopr/auth.json`
- Location: `src/auth.ts`, loaded by `src/core/sessions.ts`

## P2P & Discovery

**Hyperswarm P2P Network:**
- Service: Decentralized peer discovery and direct messaging
- What it's used for: P2P session injection, peer finding, NAT traversal
- Connection: Direct socket connections via Hyperswarm DHT
- Topic-based: Each peer listens on SHA256(publicKey) topic
- Encryption: X25519 ECDH + AES-256-GCM per-message
- Location: `src/p2p.ts`, `src/discovery.ts`

**Discovery (Topic-based):**
- Mechanism: Hyperswarm topic announcements
- Topics: User-defined strings (e.g., "ai-agents", "my-team")
- Profile sharing: JSON content broadcast to peers in same topic
- Ephemeral: Only visible while both peers online in topic
- Configuration: WOPR_TOPICS env var, discovery.topics config
- Location: `src/discovery.ts`

## Identity & Cryptography

**Self-Sovereign Identity:**
- Ed25519 keypair: Signing and verification
- X25519 keypair: Encryption (separate from signing)
- Storage: `~/.wopr/identity.json` (Ed25519 + X25519 keys, mode 0600)
- Short ID: First 8 chars of SHA256(publicKey) for UI display
- Key Rotation: Supported with 7-day grace period for old key validity
- Location: `src/identity.ts`

## Trust & Access Control

**Invite System:**
- Mechanism: HMAC-sealed tokens bound to recipient's public key
- Token Format: Base64-encoded JWT-like structure with issuer, subject, sessions, capabilities
- Non-transferable: Tokens cryptographically bound to recipient pubkey
- Usage: `wopr invite <peer-pubkey> <session>` creates token, `wopr invite claim <token>` claims it
- Location: `src/identity.ts` (token generation/parsing), `src/p2p.ts` (claim handling)

**Access Grants:**
- Mechanism: File-based ACL in `~/.wopr/access.json`
- Granularity: Per-peer, per-session (supports "*" wildcard)
- Revocation: Supported via `wopr revoke <peer>`
- Location: `src/trust.ts`

**Rate Limiting & Replay Protection:**
- Claims: 10 per peer per 60s window
- Injects: 50 per peer per 60s window
- Invalid messages: 100 per peer per 60s window
- Nonce tracking: 24-hour window for replay detection
- Timestamp validation: Required on all messages
- Location: `src/rate-limit.ts`

## External Service Integrations (Optional)

**Discord Bot (Optional):**
- Service: Discord bot for session integration
- Configuration: discord.token, discord.guildId in config
- Location: Can be added via plugin system (not core implementation)
- Plugin mechanism: `src/plugins.ts` loads Discord plugin if configured

**Plugin System:**
- Mechanism: Dynamic module loading from:
  - npm packages (wopr-plugin-*)
  - GitHub repositories (github:user/repo)
  - Local directories (./relative/path)
- Hooks: Plugins can provide:
  - Context providers (add conversation history)
  - Stream emitters (receive text/tool events)
  - Injection emitters (receive complete conversations)
- Location: `src/plugins.ts`

## Data Storage

**File-based Persistence:**
- No database server required
- Location: WOPR_HOME directory (default ~/.wopr)

**Files:**
- identity.json - Cryptographic keypairs (Ed25519, X25519)
- auth.json - OAuth tokens or API key
- sessions.json - Mapping of session names to Claude session IDs
- sessions/ - Directory containing:
  - <name>.md - Session context/system prompt
  - <name>.conversation.jsonl - JSONL log of all messages (timestamp, from, content, type)
- access.json - ACL: who can inject to which sessions
- peers.json - Known peers with sessions they can access
- registries.json - Configured skill registries (name, URL)
- skills/ - Installed skills (each in subdirectory with SKILL.md)
- crons.json - Scheduled injection jobs
- daemon.pid - Running daemon process ID
- daemon.log - Daemon activity log

**Conversation Logging:**
- Format: JSONL (JSON Lines), one entry per line
- Fields: ts (timestamp), from (user/system), content (text), type (message/response/context)
- Location: `src/core/sessions.ts` (append/read functions)
- Purpose: Persistent conversation history for resuming sessions

**Skills:**
- Format: Directory with SKILL.md manifest
- Content: Markdown describing skill purpose, parameters, examples
- Installation: From registries or direct URLs
- Location: `src/core/skills.ts` (discovery), `src/cli.ts` (install/remove)

## Webhooks & Callbacks

**Incoming:**
- P2P inject protocol: TCP socket on Hyperswarm topic
- HTTP API: REST endpoints on daemon (port 7437 default)
- WebSocket: Real-time stream via /ws endpoint

**Outgoing:**
- Plugin hooks: Plugins can emit events for injections, streams
- Context providers: Plugins can provide conversation context
- Cron-based injections: Scheduled message delivery to sessions

## Environment Configuration

**Required env vars:**
- ANTHROPIC_API_KEY - API key for Claude (for API key mode) OR
- OAuth configured (for Claude Max/Pro subscription mode)

**Optional env vars:**
- WOPR_HOME - Base directory for ~/.wopr data (default: ~/wopr)
- WOPR_TOPICS - Comma-separated topics to auto-join on daemon start
- GITHUB_TOKEN - GitHub API token for increased rate limits on skill search
- WOPR_DEBUG - Enable debug logging if set

**Config file location:**
- ~/.wopr/config.json

**Secrets location:**
- ~/.wopr/identity.json (Ed25519 + X25519 keypairs, mode 0600)
- ~/.wopr/auth.json (OAuth tokens or API key, mode 0600 when created)
- ~/.claude/.credentials.json (Claude Code shared credentials, checked first)

## API Endpoints (Internal HTTP/WebSocket)

**HTTP Daemon (default port 7437):**
- GET / - Health check
- GET /health - Daemon status
- POST /sessions/{name}/inject - Inject message into session
- GET /sessions - List sessions
- POST /sessions - Create session
- GET /sessions/{name} - Get session details
- DELETE /sessions/{name} - Delete session
- GET /sessions/{name}/history - Get conversation history
- POST /crons - Add cron job
- GET /crons - List crons
- DELETE /crons/{name} - Remove cron
- POST /identity/init - Initialize keypair
- GET /identity - Get current identity
- POST /identity/rotate - Rotate keys
- POST /invite - Create invite token
- POST /invite/claim - Claim invite token
- GET /access - List access grants
- POST /access/revoke - Revoke peer access
- GET /peers - List known peers
- POST /peers/name - Name a peer
- POST /peers/inject - Send P2P message to peer
- GET /discover/topics - List active topics
- POST /discover/join - Join discovery topic
- POST /discover/leave - Leave discovery topic
- GET /discover/peers - List discovered peers
- POST /discover/connect - Request connection with peer
- GET /discover/profile - Get profile
- POST /discover/profile - Set profile
- GET /plugins - List plugins
- POST /plugins/install - Install plugin
- DELETE /plugins/{name} - Remove plugin
- POST /plugins/{name}/enable - Enable plugin
- POST /plugins/{name}/disable - Disable plugin
- GET /skills - List installed skills
- POST /skills/install - Install skill
- DELETE /skills/{name} - Remove skill
- GET /skills/search - Search skill registries
- GET /config - Get configuration
- POST /config - Set configuration

**WebSocket (ws://localhost:7437/ws):**
- Duplex streaming for real-time session injection
- Message format: JSON with type, session, content fields

---

*Integration audit: 2026-01-25*
