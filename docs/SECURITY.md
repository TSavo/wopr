# WOPR Session Security Model

## Overview

WOPR implements a **three-layer security model** for session isolation and access control. This protects against malicious P2P peers, compromised plugins, and unauthorized cross-session access.

```
┌─────────────────────────────────────────────────────────────┐
│                    WOPR Security Model                       │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Trust Levels (WHO)                                │
│  - owner, trusted, semi-trusted, untrusted                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Capabilities (WHAT)                               │
│  - inject, inject.tools, inject.network, session.spawn, ... │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Sandbox (WHERE)                                   │
│  - Docker isolation with network/filesystem restrictions    │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### Check Current Security Status

```bash
# Via CLI
wopr security status

# Via A2A tool in a session
# Use security_whoami tool to see your trust level and capabilities
```

### Grant Access to a P2P Peer

```bash
# Grant trusted access with specific capabilities
wopr p2p grant <peer-pubkey> --profile trusted --sessions "code,research"

# Grant semi-trusted access (no tools by default)
wopr p2p grant <peer-pubkey> --profile semi-trusted --sessions "public-api"
```

### Configure a Gateway Session

```json
{
  "security": {
    "gateways": {
      "sessions": ["p2p-gateway"],
      "rules": {
        "p2p-gateway": {
          "allowForwardTo": ["code-executor", "research"],
          "allowActions": ["query", "summarize"],
          "rateLimit": { "perMinute": 10 }
        }
      }
    }
  }
}
```

---

## Layer 1: Trust Levels

Trust levels determine the baseline permissions for an injection source.

| Level | Source Examples | Default Behavior |
|-------|-----------------|------------------|
| `owner` | CLI, daemon, local API | Full access to all tools and sessions |
| `trusted` | Explicitly granted P2P peers | Scoped access per grant configuration |
| `semi-trusted` | Channel users, time-limited P2P | Limited tools, optional sandbox |
| `untrusted` | P2P discovery, unknown sources | Sandboxed, minimal/no tools |

### Trust Level Hierarchy

```
owner > trusted > semi-trusted > untrusted
```

Higher trust levels inherit all permissions of lower levels. A `trusted` source can do everything a `semi-trusted` source can, plus more.

### How Trust is Determined

1. **CLI/Daemon**: Always `owner`
2. **P2P Peers**: Based on access grant configuration
3. **Plugins**: Based on plugin manifest
4. **API**: Based on API key configuration
5. **Discovery**: Always `untrusted` (requires explicit grant to elevate)

---

## Layer 2: Capabilities

Capabilities provide fine-grained control over what actions a source can perform.

### Core Capabilities

| Capability | Description | Default For |
|------------|-------------|-------------|
| `inject` | Send messages to sessions | All trust levels |
| `inject.tools` | Use MCP tools (Read, Write, Bash, etc.) | owner, trusted |
| `inject.network` | Make HTTP requests (http_fetch) | owner only |
| `inject.exec` | Execute shell commands (exec_command) | owner only |
| `session.spawn` | Create new sessions | owner, trusted |
| `cross.inject` | Inject into other sessions | owner, gateway |
| `config.write` | Modify configuration | owner only |
| `a2a.call` | Use A2A inter-session tools | owner, trusted |

### Capability Profiles

Pre-configured capability sets for common use cases:

```typescript
const CAPABILITY_PROFILES = {
  owner: ["*"],  // All capabilities
  trusted: ["inject", "inject.tools", "session.spawn", "a2a.call"],
  "semi-trusted": ["inject", "inject.tools"],
  untrusted: ["inject"],  // Message only, no tools
  readonly: ["inject"],   // Alias for untrusted
  gateway: ["inject", "inject.tools", "cross.inject", "a2a.call"],
};
```

### Checking Capabilities

```typescript
// In code
import { hasCapability } from "./security/types.js";

if (hasCapability(["inject", "inject.tools"], "inject.network")) {
  // Has network capability
}

// Via A2A tool
// Use security_check tool: { "capability": "inject.network" }
```

---

## Layer 3: Sandbox (Docker Isolation)

For untrusted sources, WOPR can execute sessions in isolated Docker containers.

### Sandbox Features

| Feature | Configuration | Purpose |
|---------|---------------|---------|
| Read-only filesystem | `--read-only` | Prevent persistent changes |
| No network | `--network none` | Prevent data exfiltration |
| Dropped capabilities | `--cap-drop ALL` | Minimize kernel attack surface |
| Resource limits | `--memory 512m --cpus 0.5` | Prevent resource exhaustion |
| Process limits | `--pids-limit 100` | Prevent fork bombs |
| Seccomp profile | `--security-opt seccomp=...` | Syscall filtering |

### Sandbox Configuration

```json
{
  "security": {
    "trustLevels": {
      "untrusted": {
        "sandbox": {
          "enabled": true,
          "network": "none",
          "readOnly": true,
          "memory": "512m",
          "cpus": "0.5"
        }
      }
    }
  }
}
```

### When Sandbox is Used

1. Trust level has `sandbox.enabled: true`
2. Session explicitly requires sandbox
3. Source type is untrusted P2P discovery

See [SANDBOX.md](./SANDBOX.md) for detailed sandbox configuration.

---

## Gateway Sessions

Untrusted sources cannot directly inject into privileged sessions. They must go through a **gateway session**.

### Gateway Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  P2P Peer       │────▶│  Gateway        │────▶│  Privileged     │
│  (untrusted)    │     │  (semi-trusted) │     │  (owner/trusted)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
     inject              validates & forwards     executes
```

### Gateway Responsibilities

1. **Receive** - Accept injections from untrusted sources
2. **Validate** - Check against policy (allowed actions, rate limits)
3. **Transform** - Sanitize/restructure requests
4. **Forward** - Inject into appropriate privileged session
5. **Respond** - Return results to original requester

### Why Use Gateways?

- **Choke point**: All untrusted traffic goes through one place
- **Policy enforcement**: Gateway enforces rules before forwarding
- **Audit trail**: All escalations logged at gateway
- **No direct access**: Untrusted never touches privileged sessions

See [GATEWAY.md](./GATEWAY.md) for detailed gateway configuration.

---

## Security Tools (A2A)

Sessions have access to security introspection tools:

### security_whoami

Returns the caller's security context.

```json
// Response
{
  "trustLevel": "trusted",
  "capabilities": ["inject", "inject.tools", "session.spawn"],
  "sandbox": { "enabled": false },
  "source": {
    "type": "p2p",
    "identity": { "publicKey": "MCow..." }
  }
}
```

### security_check

Check if a specific action is allowed before attempting it.

```json
// Request
{ "capability": "inject.network" }

// Response
{
  "allowed": false,
  "reason": "Capability inject.network not granted for trust level 'trusted'"
}
```

---

## P2P Security Hardening

The P2P plugin includes several security measures:

### Auto-Accept Disabled

Discovered peers are NOT automatically granted access:

```typescript
// Default behavior (secure)
{
  accept: false,
  sessions: [],
  reason: "Discovery auto-accept disabled. Use p2p_grant to authorize."
}
```

### Key Rotation Grace Period

Reduced from 7 days to 24 hours for security:

```typescript
gracePeriodMs: 24 * 3600000  // 24 hours
```

### Payload Size Limits

Protection against memory exhaustion attacks:

| Limit | Value | Purpose |
|-------|-------|---------|
| `MAX_PAYLOAD_SIZE` | 1 MB | Maximum inject payload |
| `MAX_MESSAGE_SIZE` | ~1 MB + 4 KB | Maximum raw P2P message |

Messages exceeding these limits are rejected before processing.

### Rate Limiting

Per-peer rate limits for different operations:

| Operation | Default Limit |
|-----------|---------------|
| Injects | 60/minute |
| Handshakes | 10/minute |
| Claims | 5/minute |

---

## Enforcement Modes

Security can operate in different modes during migration:

| Mode | Behavior |
|------|----------|
| `off` | No enforcement, no logging |
| `warn` | Log violations but allow (default) |
| `enforce` | Block violations |

```json
{
  "security": {
    "enforcement": "warn"
  }
}
```

Start with `warn` to identify issues, then switch to `enforce`.

---

## Configuration Reference

See [SECURITY_CONFIG.md](./SECURITY_CONFIG.md) for complete configuration options.

### Minimal Secure Configuration

```json
{
  "security": {
    "enforcement": "enforce",
    "defaults": {
      "tools": { "deny": ["config.write", "inject.exec"] }
    },
    "trustLevels": {
      "untrusted": {
        "sandbox": { "enabled": true, "network": "none" },
        "tools": { "deny": ["*"] }
      }
    },
    "p2p": {
      "discoveryTrust": "untrusted",
      "autoAccept": false
    }
  }
}
```

---

## API Reference

See [SECURITY_API.md](./SECURITY_API.md) for programmatic security management.

---

## Related Documentation

- [THREAT_MODEL.md](./THREAT_MODEL.md) - Cryptographic security and threat analysis
- [GATEWAY.md](./GATEWAY.md) - Gateway session configuration
- [SANDBOX.md](./SANDBOX.md) - Docker sandbox details
- [SECURITY_CONFIG.md](./SECURITY_CONFIG.md) - Configuration reference
- [SECURITY_API.md](./SECURITY_API.md) - API reference
