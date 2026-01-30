# WOPR Security API Reference

Programmatic interfaces for security management.

---

## TypeScript API

### Import Security Module

```typescript
import {
  // Types
  type TrustLevel,
  type Capability,
  type InjectionSource,
  type SecurityConfig,
  type SecurityPolicy,

  // Trust level utilities
  compareTrustLevel,
  meetsTrustLevel,

  // Capability utilities
  hasCapability,
  expandCapabilities,
  CAPABILITY_PROFILES,

  // Source creation
  createInjectionSource,

  // Policy functions
  initSecurity,
  getSecurityConfig,
  saveSecurityConfig,
  resolvePolicy,
  checkSessionAccess,
  checkCapability,
  checkToolAccess,

  // Context functions
  SecurityContext,
  createSecurityContext,
  createCliContext,
  createDaemonContext,
  createP2PContext,

  // Sandbox functions
  isDockerAvailable,
  createSandbox,
  execInSandbox,
  destroySandbox,

  // Gateway functions
  isGateway,
  canForwardTo,
  forwardRequest,
  routeThroughGateway,
} from "@wopr/core/security";
```

---

## Trust Levels API

### Type Definition

```typescript
type TrustLevel = "owner" | "trusted" | "semi-trusted" | "untrusted";
```

### compareTrustLevel

Compare two trust levels.

```typescript
function compareTrustLevel(a: TrustLevel, b: TrustLevel): number;

// Returns:
//  -1 if a < b (a is less trusted)
//   0 if a === b
//   1 if a > b (a is more trusted)

// Examples
compareTrustLevel("owner", "trusted");      // 1
compareTrustLevel("untrusted", "trusted");  // -1
compareTrustLevel("trusted", "trusted");    // 0
```

### meetsTrustLevel

Check if a trust level meets a minimum requirement.

```typescript
function meetsTrustLevel(actual: TrustLevel, required: TrustLevel): boolean;

// Examples
meetsTrustLevel("owner", "trusted");      // true
meetsTrustLevel("untrusted", "trusted");  // false
meetsTrustLevel("trusted", "trusted");    // true
```

---

## Capabilities API

### Type Definition

```typescript
type Capability =
  | "inject"
  | "inject.tools"
  | "inject.network"
  | "inject.exec"
  | "session.spawn"
  | "cross.inject"
  | "config.write"
  | "a2a.call"
  | "*";  // Wildcard - all capabilities
```

### hasCapability

Check if a capability set includes a specific capability.

```typescript
function hasCapability(
  capabilities: Capability[],
  required: Capability
): boolean;

// Examples
hasCapability(["inject", "inject.tools"], "inject.tools");  // true
hasCapability(["inject", "inject.tools"], "inject.exec");   // false
hasCapability(["*"], "anything");                            // true
```

### expandCapabilities

Expand wildcard and nested capabilities.

```typescript
function expandCapabilities(capabilities: Capability[]): Capability[];

// Example
expandCapabilities(["inject.*"]);
// Returns: ["inject", "inject.tools", "inject.network", "inject.exec"]
```

### CAPABILITY_PROFILES

Pre-defined capability sets.

```typescript
const CAPABILITY_PROFILES: Record<string, Capability[]> = {
  owner: ["*"],
  trusted: ["inject", "inject.tools", "session.spawn", "a2a.call"],
  "semi-trusted": ["inject", "inject.tools"],
  untrusted: ["inject"],
  readonly: ["inject"],
  gateway: ["inject", "inject.tools", "cross.inject", "a2a.call"],
};
```

---

## Injection Source API

### Type Definition

```typescript
interface InjectionSource {
  type: InjectionSourceType;
  trustLevel: TrustLevel;
  identity?: {
    publicKey?: string;
    userId?: string;
    gatewaySession?: string;
    pluginName?: string;
  };
  sessionId?: string;
  timestamp?: number;
}

type InjectionSourceType =
  | "cli"
  | "daemon"
  | "p2p"
  | "p2p-discovery"
  | "plugin"
  | "cron"
  | "api"
  | "gateway"
  | "internal";
```

### createInjectionSource

Create an injection source with appropriate defaults.

```typescript
function createInjectionSource(
  type: InjectionSourceType,
  overrides?: Partial<InjectionSource>
): InjectionSource;

// Examples
const cliSource = createInjectionSource("cli");
// { type: "cli", trustLevel: "owner", timestamp: ... }

const p2pSource = createInjectionSource("p2p", {
  trustLevel: "trusted",
  identity: { publicKey: "MCow..." }
});

const gatewaySource = createInjectionSource("gateway", {
  trustLevel: "semi-trusted",
  identity: { gatewaySession: "p2p-gateway" }
});
```

---

## Security Context API

### SecurityContext Class

```typescript
class SecurityContext {
  /** The injection source */
  readonly source: InjectionSource;

  /** Target session name */
  readonly session: string;

  /** Resolved trust level */
  readonly trustLevel: TrustLevel;

  /** Granted capabilities */
  readonly capabilities: Capability[];

  /** Check if a capability is granted */
  hasCapability(cap: Capability): boolean;

  /** Check if a tool is allowed */
  isToolAllowed(toolName: string): boolean;

  /** Check if can forward to another session */
  canForward(): boolean;

  /** Get the resolved policy */
  getResolvedPolicy(): ResolvedPolicy;
}
```

### createSecurityContext

Create a security context for an injection.

```typescript
function createSecurityContext(
  source: InjectionSource,
  session: string
): SecurityContext;

// Example
const source = createInjectionSource("p2p", {
  trustLevel: "trusted",
  identity: { publicKey: "MCow..." }
});
const ctx = createSecurityContext(source, "my-session");

if (ctx.hasCapability("inject.tools")) {
  // Tools are allowed
}
```

### Context Helpers

Pre-configured context creators for common sources.

```typescript
// CLI context (owner)
function createCliContext(session: string): SecurityContext;

// Daemon context (owner)
function createDaemonContext(session: string): SecurityContext;

// Plugin context
function createPluginContext(
  pluginName: string,
  session: string,
  trustLevel?: TrustLevel
): SecurityContext;

// P2P context
function createP2PContext(
  session: string,
  publicKey: string,
  trustLevel: TrustLevel
): SecurityContext;

// P2P discovery context (untrusted)
function createP2PDiscoveryContext(
  session: string,
  publicKey: string
): SecurityContext;

// API context
function createApiContext(
  session: string,
  apiKey: string,
  trustLevel?: TrustLevel
): SecurityContext;
```

### Context Storage

Store and retrieve contexts for sessions.

```typescript
// Store context for later retrieval
function storeContext(ctx: SecurityContext): void;

// Get context for session
function getContext(session: string): SecurityContext | undefined;

// Clear context
function clearContext(session: string): void;

// Execute with context
async function withSecurityContext<T>(
  ctx: SecurityContext,
  fn: () => Promise<T>
): Promise<T>;
```

---

## Policy API

### initSecurity

Initialize the security system. Must be called at startup.

```typescript
async function initSecurity(): Promise<void>;
```

### getSecurityConfig / saveSecurityConfig

```typescript
function getSecurityConfig(): SecurityConfig;
function saveSecurityConfig(config: SecurityConfig): void;
```

### resolvePolicy

Resolve the effective policy for a source and session.

```typescript
function resolvePolicy(
  source: InjectionSource,
  session: string
): ResolvedPolicy;

interface ResolvedPolicy {
  trustLevel: TrustLevel;
  capabilities: Capability[];
  sandbox: SandboxConfig;
  tools: ToolPolicy;
}
```

### checkSessionAccess

Check if a source can inject into a session.

```typescript
function checkSessionAccess(
  source: InjectionSource,
  session: string
): PolicyCheckResult;

interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  requiredCapability?: Capability;
  requiresGateway?: boolean;
  suggestedGateway?: string;
}
```

### checkCapability

Check if a source has a capability.

```typescript
function checkCapability(
  source: InjectionSource,
  session: string,
  capability: Capability
): PolicyCheckResult;
```

### checkToolAccess

Check if a source can use a specific tool.

```typescript
function checkToolAccess(
  source: InjectionSource,
  session: string,
  toolName: string
): PolicyCheckResult;
```

### filterToolsByPolicy

Filter available tools based on policy.

```typescript
function filterToolsByPolicy(
  tools: string[],
  source: InjectionSource,
  session: string
): string[];
```

---

## Sandbox API

### isDockerAvailable

Check if Docker is available for sandboxing.

```typescript
async function isDockerAvailable(): Promise<boolean>;
```

### isSandboxImageAvailable

Check if the sandbox image exists.

```typescript
async function isSandboxImageAvailable(): Promise<boolean>;
```

### buildSandboxImage

Build the sandbox Docker image.

```typescript
async function buildSandboxImage(): Promise<void>;
```

### createSandbox

Create a new sandbox container.

```typescript
async function createSandbox(
  sessionName: string,
  config?: SandboxConfig
): Promise<SandboxInstance>;

interface SandboxInstance {
  containerId: string;
  sessionName: string;
  status: "created" | "running" | "stopped" | "destroyed";
  config: SandboxConfig;
}
```

### execInSandbox

Execute a command in a sandbox.

```typescript
async function execInSandbox(
  containerId: string,
  command: string,
  options?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  }
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;
```

### destroySandbox

Destroy a sandbox container.

```typescript
async function destroySandbox(containerId: string): Promise<void>;
```

### getSandboxStatus

Get status of a sandbox.

```typescript
async function getSandboxStatus(
  containerId: string
): Promise<SandboxInstance | null>;
```

### listSandboxes

List all sandbox containers.

```typescript
async function listSandboxes(): Promise<SandboxInstance[]>;
```

### cleanupAllSandboxes

Destroy all sandbox containers.

```typescript
async function cleanupAllSandboxes(): Promise<void>;
```

---

## Gateway API

### isGateway

Check if a session is a gateway.

```typescript
function isGateway(sessionName: string): boolean;
```

### getForwardRules

Get forward rules for a gateway.

```typescript
function getForwardRules(sessionName: string): GatewayForwardRules | null;
```

### canForwardTo

Check if gateway can forward to target.

```typescript
function canForwardTo(
  gatewaySession: string,
  targetSession: string
): boolean;
```

### forwardRequest

Forward a request through a gateway.

```typescript
async function forwardRequest(
  gatewaySession: string,
  targetSession: string,
  message: string,
  originalSource: InjectionSource,
  options?: {
    actionType?: string;
    skipApproval?: boolean;
    injectFn?: InjectFunction;
  }
): Promise<ForwardResult>;

interface ForwardResult {
  success: boolean;
  response?: string;
  error?: string;
  requestId: string;
  requiresApproval?: boolean;
}
```

### routeThroughGateway

Automatically route untrusted request through gateway.

```typescript
async function routeThroughGateway(
  source: InjectionSource,
  targetSession: string,
  message: string,
  injectFn?: InjectFunction
): Promise<ForwardResult | null>;

// Returns null if gateway not required
```

### requiresGateway

Check if a source must use gateway.

```typescript
function requiresGateway(
  source: InjectionSource,
  targetSession: string
): boolean;
```

### findGatewayForSource

Find appropriate gateway for a source.

```typescript
function findGatewayForSource(
  source: InjectionSource,
  requestedSession: string
): string | null;
```

### Approval Functions

```typescript
// Queue request for approval
function queueForApproval(request: ForwardRequest): void;

// Approve request
function approveRequest(requestId: string): ForwardRequest | null;

// Reject request
function rejectRequest(
  requestId: string,
  reason: string
): ForwardRequest | null;

// Get pending requests
function getPendingRequests(gatewaySession?: string): ForwardRequest[];

// Approve and execute
async function approveAndExecute(
  requestId: string,
  injectFn?: InjectFunction
): Promise<ForwardResult>;
```

---

## A2A Security Tools

Tools available to sessions for security introspection.

### security_whoami

Returns the caller's security context.

**Request:** (no parameters)

**Response:**
```json
{
  "trustLevel": "trusted",
  "capabilities": ["inject", "inject.tools", "session.spawn"],
  "sandbox": {
    "enabled": false
  },
  "source": {
    "type": "p2p",
    "trustLevel": "trusted",
    "identity": {
      "publicKey": "MCow..."
    }
  },
  "session": "code-assistant",
  "policy": {
    "tools": {
      "allow": ["Read", "Write", "Edit"],
      "deny": ["config.write"]
    }
  }
}
```

### security_check

Check if a specific action is allowed.

**Request:**
```json
{
  "capability": "inject.network"
}
```

**Response (allowed):**
```json
{
  "allowed": true,
  "capability": "inject.network"
}
```

**Response (denied):**
```json
{
  "allowed": false,
  "capability": "inject.network",
  "reason": "Capability inject.network not granted for trust level 'trusted'"
}
```

---

## Events

Security events emitted for auditing.

```typescript
type SecurityEventType =
  | "access_granted"
  | "access_denied"
  | "capability_check"
  | "tool_blocked"
  | "sandbox_created"
  | "sandbox_destroyed"
  | "gateway_forward"
  | "gateway_blocked"
  | "policy_violation";

interface SecurityEvent {
  type: SecurityEventType;
  timestamp: number;
  source: InjectionSource;
  session: string;
  details: Record<string, unknown>;
}

// Subscribe to events
import { events } from "@wopr/core";

events.on("security", (event: SecurityEvent) => {
  console.log(`[${event.type}] ${event.session}:`, event.details);
});
```

---

## Examples

### Check Permission Before Action

```typescript
import { createP2PContext, checkToolAccess } from "@wopr/core/security";

async function handleP2PInject(
  session: string,
  message: string,
  peerKey: string,
  trustLevel: TrustLevel
) {
  const ctx = createP2PContext(session, peerKey, trustLevel);

  // Check if Bash is allowed
  const bashCheck = checkToolAccess(ctx.source, session, "Bash");
  if (!bashCheck.allowed) {
    return { error: bashCheck.reason };
  }

  // Proceed with injection
  return inject(session, message, { source: ctx.source });
}
```

### Route Untrusted Through Gateway

```typescript
import {
  requiresGateway,
  routeThroughGateway,
  createP2PDiscoveryContext
} from "@wopr/core/security";

async function handleDiscoveredPeer(
  session: string,
  message: string,
  peerKey: string
) {
  const ctx = createP2PDiscoveryContext(session, peerKey);

  if (requiresGateway(ctx.source, session)) {
    const result = await routeThroughGateway(
      ctx.source,
      session,
      message,
      inject
    );

    if (!result) {
      return { error: "No gateway available" };
    }

    if (!result.success) {
      return { error: result.error };
    }

    return { response: result.response };
  }

  // Direct injection allowed
  return inject(session, message, { source: ctx.source });
}
```

### Sandbox Execution

```typescript
import {
  checkSandboxRequired,
  createSandbox,
  execInSandbox,
  destroySandbox
} from "@wopr/core/security";

async function runInSandboxIfRequired(
  source: InjectionSource,
  session: string,
  code: string
) {
  const policy = resolvePolicy(source, session);

  if (policy.sandbox.enabled) {
    const sandbox = await createSandbox(session, policy.sandbox);

    try {
      const result = await execInSandbox(sandbox.containerId, code);
      return result;
    } finally {
      await destroySandbox(sandbox.containerId);
    }
  }

  // Run directly
  return exec(code);
}
```

---

## Related Documentation

- [SECURITY.md](./SECURITY.md) - Security model overview
- [SECURITY_CONFIG.md](./SECURITY_CONFIG.md) - Configuration reference
- [GATEWAY.md](./GATEWAY.md) - Gateway details
- [SANDBOX.md](./SANDBOX.md) - Sandbox details
