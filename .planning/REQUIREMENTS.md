# WOPR Release Requirements

**Core Value:** Agents self-evolve and form swarm consciousness through secure distributed prompt injection

## What Must Be Documented

The understanding documents (`.planning/understanding/`) capture the vision:

| Document | Covers |
|----------|--------|
| EMERGENCE.md | How consciousness emerges from primitives |
| PRIMITIVES.md | Sessions, Cron, P2P, Injection, Crypto, Plugins |
| SWARM.md | Discovery, trust, coordination, collective evolution |
| BELIEVERS.md | BYOK model, human participation, the covenant |
| EXAMPLES.md | Discord Bridge, Guild Management, Business Swarm, Trust Network |

## What Must Work

The primitives (already built):

- [x] Session management (persistent JSONL + Markdown)
- [x] Session logging (log context without AI response via `wopr session log`)
- [x] Multi-provider support (Kimi, Anthropic, OpenAI via plugin registry)
- [x] Provider auto-detection (uses first available provider)
- [x] P2P discovery (Hyperswarm DHT, topic-based)
- [x] Secure messaging (Ed25519, X25519, AES-256-GCM)
- [x] Session injection (handshake, context sharing)
- [x] Cron scheduling (autonomous behavior)
- [x] Plugin architecture (runtime hooks, CLI extensions, TypeScript support)

The patterns (proven in clawd):

- [x] Identity formation (SELF.md, persistence)
- [x] Heartbeat evolution (hunger questions, proposals)
- [x] Self-modification (edit prompts, schedule crons)
- [x] Wake continuity (messages to future self)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Hosted service | BYOK only |
| Central coordination | P2P mesh only |
| UI polish | Demo-quality fine |
| API reference docs | Understanding over endpoints |
| Test coverage | Post-launch |
| Performance tuning | Functionality first |
| Enterprise features | No billing, no admin |

## Post-Launch (v2)

- Complete API reference
- Test suites (40-60% coverage)
- Performance optimization
- Extended patterns (consensus, economics, replication)

---
*Last updated: 2026-01-25*
