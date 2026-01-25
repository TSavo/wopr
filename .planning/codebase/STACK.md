# Technology Stack

**Analysis Date:** 2026-01-25

## Languages

**Primary:**
- TypeScript 5.0.0 - All source code, compiled to ES2022
- Node.js (JavaScript runtime) - Server-side execution

**Secondary:**
- Bash/shell - CLI wrapper scripts, daemon management

## Runtime

**Environment:**
- Node.js 20+ (specified in Dockerfile)

**Package Manager:**
- npm (with package-lock.json)
- Lockfile: Present at `/home/tsavo/wopr/package-lock.json`

## Frameworks

**Core:**
- Hono 4.6.0 - Lightweight HTTP/REST server for daemon (`src/daemon/index.ts`)
- @anthropic-ai/claude-agent-sdk 0.2.12 - Claude conversation management and inference (`src/core/sessions.ts`)

**Networking & P2P:**
- Hyperswarm 4.16.0 - DHT-based P2P discovery and connection (`src/p2p.ts`)
- WebSocket (ws 8.19.0) - Real-time bidirectional communication via @hono/node-ws 1.0.0

**HTTP Server:**
- @hono/node-server 1.13.0 - Node.js adapter for Hono
- @hono/node-ws 1.0.0 - WebSocket support for Hono

## Key Dependencies

**Critical:**
- @anthropic-ai/claude-agent-sdk 0.2.12 - Powers all Claude session management, inference, and tool use; why it matters: core product dependency for AI conversation functionality
- hyperswarm 4.16.0 - Enables P2P networking without central servers; why it matters: foundational for decentralized peer discovery and message routing
- hono 4.6.0 - RESTful daemon API; why it matters: exposes all WOPR functionality via HTTP/WebSocket

**Utilities:**
- Node built-ins: fs, crypto, path, os, child_process, http, stream
  - fs: Session storage, configuration files, plugin management
  - crypto: Ed25519 signatures, X25519 ECDH encryption, key generation
  - child_process: Daemon spawning (nohup)

## Cryptography & Security

**Authentication & Encryption:**
- Ed25519 (Node.js native crypto) - Message signing and verification
- X25519 (Node.js native crypto) - Ephemeral key exchange for forward secrecy
- AES-256-GCM (Node.js native crypto) - Message encryption
- PKCE (RFC 7636) - OAuth2 authorization code flow security

**Location:** `src/identity.ts`, `src/auth.ts`, `src/p2p.ts`

## Configuration

**Environment:**
- WOPR_HOME - Base directory (default: `~/.wopr` or `~/wopr`)
- ANTHROPIC_API_KEY - Required for Claude API access
- WOPR_TOPICS - Comma-separated discovery topics for daemon startup
- GITHUB_TOKEN - Optional, for skill registry search via GitHub API
- WOPR_DEBUG - Optional, enables debug logging

**Build:**
- tsconfig.json - TypeScript compiler config
  - Target: ES2022
  - Module: NodeNext (ESM)
  - Strict mode enabled
  - Declaration files generated

**Local Files:**
- config.json - User configuration (daemon port, host, OAuth settings, Discord, discovery topics)
- daemon.log - Daemon activity logs
- daemon.pid - Running daemon process ID

## Platform Requirements

**Development:**
- Node.js 20+ (LTS recommended)
- npm 9+ (for package management)
- TypeScript 5.0+
- Git (for plugin installation from repositories)

**Production:**
- Docker container (Node 20-slim base image)
- Mount point: `/data` for persistent state (WOPR_HOME)
- UDP port 49737 for Hyperswarm P2P discovery
- TCP port 7437 (default daemon HTTP port, configurable)
- ANTHROPIC_API_KEY environment variable

## Build Process

**Commands:**
- `npm run build` - TypeScript compilation (tsc) to `dist/`
- `npm run dev` - Development with tsx (TS runner)
- `npm run daemon` - Start daemon in foreground

**Output:**
- Compiled JavaScript in `dist/` directory
- Executable CLI: `dist/cli.js`
- Source maps: Not explicitly configured

## Special Infrastructure

**P2P Network:**
- Hyperswarm DHT-based topology
- Topic-based discovery channels
- NAT traversal built-in
- No central server dependency

**Session Persistence:**
- Conversation logs stored as JSONL files (`sessions/<name>.conversation.jsonl`)
- Session context stored as Markdown (`sessions/<name>.md`)
- Session ID mappings in JSON (`sessions.json`)

**Storage:**
- File-based (no database server required)
- Located in WOPR_HOME directory
- Includes: sessions, skills, registries, identity, peers, access grants, crons

---

*Stack analysis: 2026-01-25*
