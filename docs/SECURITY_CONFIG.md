# WOPR Security Configuration Reference

Complete reference for all security configuration options.

## Configuration File Location

Security settings are stored in `~/.wopr/security.json` or can be embedded in the main `config.json`.

```bash
# View current security config
wopr security status

# Edit security config
wopr config edit security
```

---

## Full Configuration Schema

```typescript
interface SecurityConfig {
  /** Enforcement mode: "off" | "warn" | "enforce" */
  enforcement?: "off" | "warn" | "enforce";

  /** Default policy for all sessions */
  defaults?: SecurityPolicy;

  /** Policies by trust level */
  trustLevels?: {
    owner?: SecurityPolicy;
    trusted?: SecurityPolicy;
    "semi-trusted"?: SecurityPolicy;
    untrusted?: SecurityPolicy;
  };

  /** Session-specific overrides */
  sessions?: {
    [sessionName: string]: SecurityPolicy;
  };

  /** Gateway configuration */
  gateways?: GatewayConfig;

  /** P2P-specific security settings */
  p2p?: P2PSecurityConfig;
}

interface SecurityPolicy {
  /** Sandbox configuration */
  sandbox?: SandboxConfig;

  /** Tool access control */
  tools?: ToolPolicy;

  /** Capabilities to grant */
  capabilities?: Capability[];
}

interface SandboxConfig {
  /** Enable Docker sandboxing */
  enabled?: boolean;

  /** Network mode: "none" | "bridge" | "host" */
  network?: "none" | "bridge" | "host";

  /** Read-only root filesystem */
  readOnly?: boolean;

  /** Memory limit (e.g., "512m", "1g") */
  memory?: string;

  /** CPU limit (e.g., "0.5", "2") */
  cpus?: string;

  /** Process ID limit */
  pidsLimit?: number;
}

interface ToolPolicy {
  /** Tools to explicitly allow (overrides deny) */
  allow?: string[];

  /** Tools to deny */
  deny?: string[];

  /** Require approval for these tools */
  requireApproval?: string[];
}

interface GatewayConfig {
  /** Sessions that act as gateways */
  sessions?: string[];

  /** Forward rules per gateway */
  rules?: {
    [gatewaySession: string]: GatewayForwardRules;
  };
}

interface GatewayForwardRules {
  /** Sessions this gateway can forward to */
  allowForwardTo: string[];

  /** Action types allowed */
  allowActions?: string[];

  /** Require owner approval for forwards */
  requireApproval?: boolean;

  /** Rate limit */
  rateLimit?: {
    perMinute: number;
  };
}

interface P2PSecurityConfig {
  /** Trust level for discovered peers */
  discoveryTrust?: TrustLevel;

  /** Auto-accept discovered peers (DANGEROUS - default: false) */
  autoAccept?: boolean;

  /** Key rotation grace period in hours */
  keyRotationGraceHours?: number;

  /** Maximum payload size in bytes */
  maxPayloadSize?: number;
}
```

---

## Configuration Examples

### Example 1: Secure Default Configuration

Recommended starting point for production:

```json
{
  "security": {
    "enforcement": "enforce",

    "defaults": {
      "sandbox": { "enabled": false },
      "tools": {
        "deny": ["config.write"]
      }
    },

    "trustLevels": {
      "untrusted": {
        "sandbox": {
          "enabled": true,
          "network": "none",
          "readOnly": true,
          "memory": "512m",
          "cpus": "0.5"
        },
        "tools": {
          "deny": ["*"]
        }
      },
      "semi-trusted": {
        "sandbox": { "enabled": false },
        "tools": {
          "deny": ["exec_command", "http_fetch", "config.write"]
        }
      },
      "trusted": {
        "sandbox": { "enabled": false },
        "tools": {
          "deny": ["config.write"]
        }
      }
    },

    "p2p": {
      "discoveryTrust": "untrusted",
      "autoAccept": false,
      "keyRotationGraceHours": 24,
      "maxPayloadSize": 1048576
    }
  }
}
```

### Example 2: Gateway Configuration

Route untrusted P2P traffic through a gateway:

```json
{
  "security": {
    "enforcement": "enforce",

    "gateways": {
      "sessions": ["p2p-gateway", "api-gateway"],
      "rules": {
        "p2p-gateway": {
          "allowForwardTo": ["code-assistant", "research"],
          "allowActions": ["query", "summarize", "explain"],
          "requireApproval": false,
          "rateLimit": { "perMinute": 20 }
        },
        "api-gateway": {
          "allowForwardTo": ["code-assistant"],
          "allowActions": ["query"],
          "requireApproval": true,
          "rateLimit": { "perMinute": 60 }
        }
      }
    },

    "sessions": {
      "p2p-gateway": {
        "capabilities": ["inject", "inject.tools", "cross.inject"]
      },
      "code-assistant": {
        "tools": {
          "allow": ["Read", "Write", "Edit", "Glob", "Grep"]
        }
      }
    }
  }
}
```

### Example 3: Sandbox-Heavy Configuration

Maximum isolation for high-security environments:

```json
{
  "security": {
    "enforcement": "enforce",

    "defaults": {
      "sandbox": {
        "enabled": true,
        "network": "none",
        "readOnly": true,
        "memory": "256m",
        "cpus": "0.25",
        "pidsLimit": 50
      },
      "tools": {
        "deny": ["*"]
      }
    },

    "trustLevels": {
      "owner": {
        "sandbox": { "enabled": false },
        "tools": { "allow": ["*"] }
      },
      "trusted": {
        "sandbox": {
          "enabled": true,
          "network": "bridge",
          "readOnly": false,
          "memory": "1g"
        },
        "tools": {
          "allow": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]
        }
      }
    }
  }
}
```

### Example 4: Development/Testing Configuration

Relaxed for local development:

```json
{
  "security": {
    "enforcement": "warn",

    "defaults": {
      "sandbox": { "enabled": false },
      "tools": { "allow": ["*"] }
    },

    "p2p": {
      "discoveryTrust": "semi-trusted",
      "autoAccept": false
    }
  }
}
```

### Example 5: Session-Specific Overrides

Different policies for different sessions:

```json
{
  "security": {
    "enforcement": "enforce",

    "sessions": {
      "code-review": {
        "tools": {
          "allow": ["Read", "Glob", "Grep"],
          "deny": ["Write", "Edit", "Bash"]
        }
      },
      "code-executor": {
        "sandbox": {
          "enabled": true,
          "network": "none"
        },
        "tools": {
          "allow": ["Read", "Write", "Edit", "Bash"]
        }
      },
      "research": {
        "tools": {
          "allow": ["Read", "Glob", "Grep", "http_fetch"]
        }
      },
      "admin": {
        "capabilities": ["*"]
      }
    }
  }
}
```

---

## Tool Reference

### Tool-to-Capability Mapping

| Tool | Required Capability |
|------|---------------------|
| `sessions_send` | `cross.inject` |
| `sessions_spawn` | `session.spawn` |
| `sessions_list` | `inject` |
| `http_fetch` | `inject.network` |
| `exec_command` | `inject.exec` |
| `config_get` | `inject` |
| `config_set` | `config.write` |
| `memory_read` | `inject` |
| `memory_write` | `inject.tools` |
| `cron_schedule` | `inject.tools` |
| `event_emit` | `inject.tools` |
| `security_whoami` | `inject` |
| `security_check` | `inject` |

### Default MCP Tools

These tools are available based on capabilities:

| Tool | Category |
|------|----------|
| `Read`, `Write`, `Edit` | File I/O |
| `Glob`, `Grep` | Search |
| `Bash` | Shell execution |
| `WebFetch` | Network |
| `Task` | Agent spawning |
| `TodoWrite` | Task management |

---

## Environment Variables

Security can also be configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `WOPR_SECURITY_ENFORCEMENT` | Enforcement mode | `warn` |
| `WOPR_SECURITY_DEFAULT_SANDBOX` | Enable default sandbox | `false` |
| `WOPR_P2P_AUTO_ACCEPT` | Auto-accept P2P peers | `false` |
| `WOPR_P2P_DISCOVERY_TRUST` | Trust level for discovery | `untrusted` |

Example:
```bash
WOPR_SECURITY_ENFORCEMENT=enforce wopr daemon start
```

---

## CLI Commands

### View Security Status

```bash
# Global security config
wopr security status

# Session-specific policy
wopr security status my-session

# Check enforcement mode
wopr security status --enforcement
```

### Manage Access Grants

```bash
# Grant access to P2P peer
wopr security grant <peer-key> --profile trusted --sessions "code,research"

# Grant with specific capabilities
wopr security grant <peer-key> --capabilities "inject,inject.tools"

# Revoke access
wopr security revoke <peer-key>

# List all grants
wopr security list-grants
```

### Configure Policies

```bash
# Enable sandbox for a trust level
wopr security policy set --trust-level untrusted --sandbox enabled

# Deny specific tools
wopr security policy set --session my-session --tools.deny "exec_command,http_fetch"

# Set enforcement mode
wopr security policy set --enforcement enforce
```

### Gateway Management

```bash
# List gateways
wopr security gateway list

# Add gateway session
wopr security gateway add p2p-gateway

# View forward rules
wopr security gateway rules p2p-gateway

# Approve pending request
wopr security gateway approve <request-id>
```

### Audit

```bash
# View recent security events
wopr security audit

# View denied actions only
wopr security audit --denied

# View events for specific session
wopr security audit --session my-session
```

---

## Migration Guide

### From No Security to Warn Mode

1. Add minimal config:
```json
{
  "security": {
    "enforcement": "warn"
  }
}
```

2. Monitor logs for violations
3. Adjust policies based on findings

### From Warn to Enforce Mode

1. Review all logged violations
2. Ensure legitimate actions have proper grants
3. Update config:
```json
{
  "security": {
    "enforcement": "enforce"
  }
}
```

4. Test critical workflows
5. Deploy to production

---

## Troubleshooting

### "Access denied: capability X not granted"

The source doesn't have the required capability. Either:
1. Grant the capability to the source
2. Use a gateway to forward the request
3. Check if the action is necessary

### "Sandbox creation failed"

Docker may not be available or properly configured:
1. Check Docker is installed and running
2. Verify wopr-sandbox image exists: `docker images | grep wopr-sandbox`
3. Build image if needed: `wopr sandbox build`

### "Gateway forward rejected"

The gateway doesn't allow the requested action:
1. Check gateway rules allow the target session
2. Check action type is in `allowActions`
3. Verify rate limits aren't exceeded

---

## Related Documentation

- [SECURITY.md](./SECURITY.md) - Security model overview
- [GATEWAY.md](./GATEWAY.md) - Gateway session details
- [SANDBOX.md](./SANDBOX.md) - Docker sandbox details
- [SECURITY_API.md](./SECURITY_API.md) - API reference
