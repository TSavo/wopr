# WOPR Gateway Sessions

Gateway sessions provide controlled escalation from untrusted sources to privileged sessions.

---

## Overview

In WOPR's security model, untrusted sources (like P2P discovery peers) cannot directly inject into privileged sessions. Instead, they must route through a **gateway session** that:

1. Validates requests against policy
2. Transforms/sanitizes requests
3. Forwards to appropriate privileged sessions
4. Returns results to the original requester

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Untrusted      │────▶│    Gateway      │────▶│   Privileged    │
│  Source         │     │    Session      │     │   Session       │
│  (P2P peer)     │     │  (validates)    │     │  (executes)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        │    inject             │   forward             │
        │    "query X"          │   (if allowed)        │
        │                       │                       │
        │◀──────────────────────│◀──────────────────────│
        │    response           │   result              │
```

---

## Why Gateways?

### Problem: Direct Access Risks

Without gateways, any untrusted source could potentially:
- Inject malicious prompts into sensitive sessions
- Access tools beyond their authorization
- Exfiltrate data through cross-session communication
- Overwhelm sessions with requests

### Solution: Choke Point Architecture

Gateways provide:

| Benefit | Description |
|---------|-------------|
| **Centralized Policy** | All untrusted traffic flows through one point |
| **Validation** | Requests checked against rules before forwarding |
| **Transformation** | Requests can be sanitized/modified |
| **Rate Limiting** | Prevent abuse through throttling |
| **Audit Trail** | All escalations logged |
| **Approval Workflow** | Optional human approval for sensitive forwards |

---

## Configuration

### Designate Gateway Sessions

```json
{
  "security": {
    "gateways": {
      "sessions": ["p2p-gateway", "api-gateway", "public-gateway"]
    }
  }
}
```

### Configure Forward Rules

Each gateway has rules defining what it can forward:

```json
{
  "security": {
    "gateways": {
      "sessions": ["p2p-gateway"],
      "rules": {
        "p2p-gateway": {
          "allowForwardTo": ["code-assistant", "research", "general"],
          "allowActions": ["query", "summarize", "explain", "search"],
          "requireApproval": false,
          "rateLimit": {
            "perMinute": 20
          }
        }
      }
    }
  }
}
```

### Rule Properties

| Property | Type | Description |
|----------|------|-------------|
| `allowForwardTo` | `string[]` | Sessions this gateway can forward to |
| `allowActions` | `string[]` | Action types allowed (optional filter) |
| `requireApproval` | `boolean` | Queue forwards for owner approval |
| `rateLimit.perMinute` | `number` | Maximum forwards per minute |

---

## Forward Flow

### 1. Request Reception

Gateway receives injection from untrusted source:

```typescript
// Untrusted P2P peer sends:
{
  type: "inject",
  session: "code-assistant",  // Target
  payload: "Explain this code...",
  from: "MCow..."  // Peer's public key
}
```

### 2. Gateway Interception

Security layer intercepts and routes through gateway:

```typescript
// In sessions.ts inject()
if (requiresGateway(source, targetSession)) {
  const gateway = findGatewayForSource(source, targetSession);
  return routeThroughGateway(source, targetSession, message, injectFn);
}
```

### 3. Policy Validation

Gateway validates against rules:

```typescript
// Checks performed:
// 1. Is target in allowForwardTo?
// 2. Is action type in allowActions?
// 3. Is rate limit exceeded?
// 4. Does source have inject capability?

const validation = validateForwardRequest(request, gatewayContext);
if (!validation.valid) {
  return { error: validation.reason };
}
```

### 4. Approval (Optional)

If `requireApproval: true`:

```typescript
// Request queued for approval
queueForApproval(request);

// Returns to caller
return {
  success: false,
  requiresApproval: true,
  requestId: "fwd-abc123"
};

// Owner must approve via:
// - CLI: wopr security gateway approve fwd-abc123
// - A2A: gateway_approve tool
```

### 5. Forward Execution

```typescript
// Create forwarded context (semi-trusted, carries original identity)
const forwardedContext = createForwardedContext(request);

// Execute injection in target session
const result = await injectFn(targetSession, message, {
  source: forwardedContext.source,
  silent: true
});
```

### 6. Response Return

Result returned to original requester through P2P channel.

---

## Gateway Tools (A2A)

Gateway sessions have access to special tools:

### gateway_forward

Forward a request to another session.

```json
{
  "name": "gateway_forward",
  "parameters": {
    "target": "code-assistant",
    "message": "Explain this function..."
  }
}
```

### gateway_queue

View pending requests awaiting approval.

```json
{
  "name": "gateway_queue",
  "parameters": {}
}

// Response:
{
  "pending": [
    {
      "requestId": "fwd-abc123",
      "from": "MCow...",
      "target": "code-assistant",
      "message": "...",
      "timestamp": 1706500000000
    }
  ]
}
```

### gateway_approve

Approve a pending request.

```json
{
  "name": "gateway_approve",
  "parameters": {
    "requestId": "fwd-abc123"
  }
}
```

### gateway_reject

Reject a pending request.

```json
{
  "name": "gateway_reject",
  "parameters": {
    "requestId": "fwd-abc123",
    "reason": "Request contains potentially harmful content"
  }
}
```

---

## Action Type Filtering

Optionally filter forwards by action type:

```json
{
  "allowActions": ["query", "summarize", "explain"]
}
```

The action type is determined from the message content or explicit parameter. This allows:

- **query**: General questions
- **summarize**: Summarization requests
- **explain**: Code/concept explanations
- **search**: Search operations
- **execute**: Code execution (typically denied)
- **modify**: File modifications (typically denied)

---

## Rate Limiting

Per-gateway rate limits prevent abuse:

```json
{
  "rateLimit": {
    "perMinute": 20
  }
}
```

Rate limits are tracked per source-target pair:

```typescript
// Key: "p2p-gateway:code-assistant"
// Tracks: count, resetAt
```

When exceeded:

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "requestId": "fwd-xyz789"
}
```

---

## Approval Workflow

For sensitive operations, enable approval:

```json
{
  "requireApproval": true
}
```

### Approval Process

1. **Request Queued**: Forward request added to pending queue
2. **Notification**: Owner notified (CLI prompt, event, etc.)
3. **Review**: Owner reviews request details
4. **Decision**: Approve or reject with reason
5. **Execution**: If approved, forward executes
6. **Expiration**: Pending requests expire after 5 minutes

### CLI Management

```bash
# View pending requests
wopr security gateway queue

# View for specific gateway
wopr security gateway queue p2p-gateway

# Approve request
wopr security gateway approve fwd-abc123

# Reject request
wopr security gateway reject fwd-abc123 --reason "Suspicious request"
```

---

## Example Configurations

### Public API Gateway

Accept queries from any authenticated API client:

```json
{
  "gateways": {
    "sessions": ["api-gateway"],
    "rules": {
      "api-gateway": {
        "allowForwardTo": ["general", "help"],
        "allowActions": ["query"],
        "requireApproval": false,
        "rateLimit": { "perMinute": 60 }
      }
    }
  }
}
```

### P2P Collaboration Gateway

Allow trusted P2P peers to collaborate:

```json
{
  "gateways": {
    "sessions": ["p2p-gateway"],
    "rules": {
      "p2p-gateway": {
        "allowForwardTo": ["code-assistant", "research", "review"],
        "allowActions": ["query", "explain", "summarize", "search"],
        "requireApproval": false,
        "rateLimit": { "perMinute": 30 }
      }
    }
  }
}
```

### High-Security Gateway

Require approval for all forwards:

```json
{
  "gateways": {
    "sessions": ["secure-gateway"],
    "rules": {
      "secure-gateway": {
        "allowForwardTo": ["admin"],
        "allowActions": ["query"],
        "requireApproval": true,
        "rateLimit": { "perMinute": 5 }
      }
    }
  }
}
```

---

## Forwarded Context

When a request is forwarded, the target session receives a modified security context:

```typescript
{
  source: {
    type: "gateway",
    trustLevel: "semi-trusted",  // Reduced from original
    identity: {
      gatewaySession: "p2p-gateway",
      publicKey: "MCow..."  // Original requester
    }
  }
}
```

This allows the target session to:
- Know the request came through a gateway
- Identify the original requester
- Apply appropriate capability restrictions

---

## Audit Logging

All gateway activity is logged:

```
[gateway] Forward request fwd-abc123: p2p-gateway -> code-assistant
[gateway] Request fwd-abc123 validated
[gateway] Executing forward fwd-abc123
[gateway] Request fwd-abc123 completed
```

For approval workflow:
```
[gateway] Request fwd-xyz789 queued for approval
[gateway] Request fwd-xyz789 approved by owner
[gateway] Executing forward fwd-xyz789
```

---

## Security Considerations

### Gateway Trust Level

Gateways need the `cross.inject` capability:

```json
{
  "sessions": {
    "p2p-gateway": {
      "capabilities": ["inject", "inject.tools", "cross.inject"]
    }
  }
}
```

### Gateway Isolation

Run gateways in separate sessions to limit blast radius:

```bash
# Start dedicated gateway session
wopr session start p2p-gateway --config gateway.json
```

### Minimal Forward Rules

Only allow forwarding to sessions that need external access:

```json
{
  "allowForwardTo": ["public-api"],  // Not ["*"]
  "allowActions": ["query"]           // Not ["*"]
}
```

### Monitor Gateway Traffic

Enable security event logging:

```bash
wopr security audit --gateway
```

---

## Troubleshooting

### "No gateway available for this request"

No configured gateway can forward to the requested session.

**Fix**: Add target session to a gateway's `allowForwardTo` list.

### "Rate limit exceeded"

Too many requests in the time window.

**Fix**: Increase `rateLimit.perMinute` or add additional gateways.

### "Request queued for approval" (unexpected)

Gateway has `requireApproval: true`.

**Fix**: Set `requireApproval: false` or approve manually.

### "Action type not allowed"

Request action not in `allowActions` list.

**Fix**: Add action type to `allowActions` or remove filter.

---

## Related Documentation

- [SECURITY.md](./SECURITY.md) - Security model overview
- [SECURITY_CONFIG.md](./SECURITY_CONFIG.md) - Configuration reference
- [SECURITY_API.md](./SECURITY_API.md) - API reference
- [SANDBOX.md](./SANDBOX.md) - Docker sandbox details
