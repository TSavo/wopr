# Changelog

All notable changes to WOPR will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Event bus system for reactive plugin composition
- Plugin hooks API for mutable lifecycle events
- `ctx.events` and `ctx.hooks` in plugin context
- Session lifecycle events: create, beforeInject, afterInject, responseChunk, destroy
- Channel events: message, send
- Plugin lifecycle events: beforeInit, afterInit, error
- System events: configChange, shutdown
- Comprehensive events documentation
- Plugin examples: event-monitor, session-analytics

## [1.0.0] - 2025-01-29

### Added
- **Core P2P System**
  - Ed25519/X25519 cryptographic identity
  - End-to-end encrypted messaging (AES-256-GCM)
  - Forward secrecy with ephemeral keys
  - Hyperswarm DHT-based peer discovery
  - Signed invites bound to recipient public keys
  - Key rotation with peer notification

- **AI Session Management**
  - Named persistent sessions with context
  - Multi-provider AI support (auto-detection)
  - Session resumption across restarts
  - Conversation history (JSONL format)
  - Context file support (`.md` files)

- **Plugin System**
  - Dynamic plugin loading
  - Channel adapters (Discord, Slack, Telegram, etc.)
  - Model provider plugins
  - Middleware support
  - Configuration schemas
  - Web UI extensions
  - UI components (SolidJS)

- **Official Channel Plugins**
  - Discord with reactions and threading
  - Slack with Socket Mode
  - Telegram with Grammy
  - WhatsApp with Baileys
  - Signal with signal-cli
  - iMessage (macOS only)
  - Microsoft Teams

- **Official Provider Plugins**
  - Moonshot AI Kimi
  - OpenAI
  - Anthropic Claude

- **Skills System**
  - Skill registry management
  - GitHub-based skill distribution
  - Automatic skill loading
  - Built-in skill collection

- **Scheduled Injections**
  - Cron-style scheduling
  - Natural language scheduling (`+1h`, `@daily`)
  - One-time future injections

- **Workspace Identity**
  - AGENTS.md - Agent persona
  - SOUL.md - Agent essence/values
  - USER.md - User profile
  - Automatic context injection

- **Onboarding Wizard**
  - Interactive setup (`wopr onboard`)
  - Provider configuration
  - Channel plugin setup
  - P2P networking setup

- **Discovery**
  - Topic-based peer discovery
  - Ephemeral peer advertisements
  - Profile-based filtering
  - Connection requests

- **HTTP API**
  - RESTful session management
  - Streaming injection endpoint
  - Plugin management
  - Configuration API
  - WebSocket support

- **CLI**
  - Session commands (create, inject, log, list, show, delete)
  - Identity management
  - Peer management
  - Invite system (create, claim, revoke)
  - Plugin commands (install, enable, disable, list)
  - Skill commands (registry, install, list)
  - Cron commands (add, remove, list, run)
  - Discovery commands (join, leave, peers, connect)
  - Daemon commands (start, stop, status, logs)

- **Security**
  - Rate limiting
  - Replay protection
  - Nonce validation
  - Timestamp validation
  - Comprehensive threat model

- **Documentation**
  - Architecture documentation
  - Protocol specification
  - Threat model analysis
  - Plugin development guide
  - API reference
  - Event system documentation

### Security
- Implements v2 protocol with forward secrecy
- Invites cryptographically bound to recipient
- All messages signed and encrypted
- Key rotation support

## [0.9.0] - 2024-12-15

### Added
- Initial beta release
- Basic P2P messaging
- Session management
- Plugin system foundation
- Discord plugin prototype

[Unreleased]: https://github.com/TSavo/wopr/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/TSavo/wopr/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/TSavo/wopr/releases/tag/v0.9.0
