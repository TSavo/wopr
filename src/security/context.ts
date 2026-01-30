/**
 * WOPR Security Context
 *
 * SecurityContext is attached to each injection and carries the security
 * metadata through the request lifecycle. It provides methods for checking
 * permissions and tracking security events.
 */

import { logger } from "../logger.js";
import {
  type InjectionSource,
  type TrustLevel,
  type Capability,
  type SecurityEvent,
  type SecurityEventType,
  createInjectionSource,
} from "./types.js";
import {
  resolvePolicy,
  checkSessionAccess,
  checkCapability,
  checkToolAccess,
  checkSandboxRequired,
  filterToolsByPolicy,
  isEnforcementEnabled,
  shouldLogSecurityEvent,
  type ResolvedPolicy,
  type PolicyCheckResult,
} from "./policy.js";

// ============================================================================
// Security Context
// ============================================================================

/**
 * Security context for an injection
 *
 * Carries security metadata and provides permission checking methods.
 * Created when an injection starts and passed through the request lifecycle.
 */
export class SecurityContext {
  /** The injection source */
  readonly source: InjectionSource;

  /** Target session name */
  readonly session: string;

  /** Resolved policy for this context */
  private _policy: ResolvedPolicy | null = null;

  /** Security events recorded during this request */
  private _events: SecurityEvent[] = [];

  /** Timestamp when context was created */
  readonly createdAt: number;

  /** Request ID for tracing */
  readonly requestId: string;

  constructor(source: InjectionSource, session: string) {
    this.source = source;
    this.session = session;
    this.createdAt = Date.now();
    this.requestId = generateRequestId();
  }

  /**
   * Get the resolved policy (lazily computed)
   */
  get policy(): ResolvedPolicy {
    if (!this._policy) {
      this._policy = resolvePolicy(this.source, this.session);
    }
    return this._policy;
  }

  /**
   * Get the resolved policy (method version for tools)
   */
  getResolvedPolicy(): ResolvedPolicy {
    return this.policy;
  }

  /**
   * Get the effective trust level
   */
  get trustLevel(): TrustLevel {
    return this.source.trustLevel;
  }

  /**
   * Get effective capabilities
   */
  get capabilities(): Capability[] {
    return this.policy.capabilities;
  }

  /**
   * Check if this context has a specific capability
   */
  hasCapability(capability: Capability): boolean {
    const result = checkCapability(this.source, capability, this.session);
    this.recordEvent("capability_check", {
      capability,
      allowed: result.allowed,
      reason: result.reason,
    });
    return result.allowed;
  }

  /**
   * Check if this context can access the target session
   */
  canAccessSession(): PolicyCheckResult {
    const result = checkSessionAccess(this.source, this.session);
    this.recordEvent(result.allowed ? "access_granted" : "access_denied", {
      allowed: result.allowed,
      reason: result.reason,
    });
    return result;
  }

  /**
   * Check if this context can use a specific tool
   */
  canUseTool(toolName: string): PolicyCheckResult {
    const result = checkToolAccess(this.source, toolName, this.session);

    // Log warning if in warn mode
    if (result.warning) {
      logger.warn(`[security] ${this.requestId}: ${result.warning}`);
    }

    this.recordEvent("capability_check", {
      tool: toolName,
      allowed: result.allowed,
      reason: result.reason,
    });

    return result;
  }

  /**
   * Filter tools to only those allowed for this context
   */
  filterTools(availableTools: string[]): string[] {
    return filterToolsByPolicy(this.source, availableTools, this.session);
  }

  /**
   * Check if sandbox execution is required
   */
  requiresSandbox(): boolean {
    const sandbox = checkSandboxRequired(this.source, this.session);
    return sandbox !== null && sandbox.enabled;
  }

  /**
   * Get sandbox configuration if required
   */
  getSandboxConfig() {
    return checkSandboxRequired(this.source, this.session);
  }

  /**
   * Check if this context is for a gateway session
   */
  isGateway(): boolean {
    return this.policy.isGateway;
  }

  /**
   * Check if this context can forward to other sessions
   */
  canForward(): boolean {
    return this.policy.canForward;
  }

  /**
   * Get forward rules if this is a gateway
   */
  getForwardRules() {
    return this.policy.forwardRules;
  }

  /**
   * Record a security event
   */
  recordEvent(
    type: SecurityEventType,
    details: Partial<SecurityEvent>
  ): void {
    const event: SecurityEvent = {
      type,
      timestamp: Date.now(),
      source: this.source,
      session: this.session,
      allowed: details.allowed ?? true,
      ...details,
    };

    this._events.push(event);

    // Log if configured
    if (shouldLogSecurityEvent(event.allowed)) {
      const level = event.allowed ? "info" : "warn";
      logger[level](
        `[security] ${this.requestId}: ${type} - ${event.allowed ? "ALLOWED" : "DENIED"}` +
          (event.reason ? ` (${event.reason})` : "") +
          (event.tool ? ` tool=${event.tool}` : "") +
          (event.capability ? ` cap=${event.capability}` : "")
      );
    }
  }

  /**
   * Get all recorded events
   */
  getEvents(): SecurityEvent[] {
    return [...this._events];
  }

  /**
   * Create a derived context for forwarding
   */
  deriveForForward(targetSession: string): SecurityContext {
    // When forwarding, the source becomes the gateway
    const derivedSource = createInjectionSource("gateway", {
      trustLevel: "semi-trusted", // Forwarded requests are semi-trusted
      identity: {
        gatewaySession: this.session,
        publicKey: this.source.identity?.publicKey,
      },
      grantedCapabilities: this.policy.forwardRules?.allowActions?.map(
        (a) => a as Capability
      ),
    });

    return new SecurityContext(derivedSource, targetSession);
  }

  /**
   * Serialize context for logging/debugging
   */
  toJSON(): Record<string, unknown> {
    return {
      requestId: this.requestId,
      session: this.session,
      source: {
        type: this.source.type,
        trustLevel: this.source.trustLevel,
        identity: this.source.identity,
      },
      policy: {
        capabilities: this.policy.capabilities,
        sandbox: this.policy.sandbox,
        isGateway: this.policy.isGateway,
      },
      createdAt: this.createdAt,
      eventCount: this._events.length,
    };
  }
}

// ============================================================================
// Context Factory
// ============================================================================

/**
 * Create a security context for an injection
 */
export function createSecurityContext(
  source: InjectionSource,
  session: string
): SecurityContext {
  return new SecurityContext(source, session);
}

/**
 * Create a security context for CLI commands (owner trust)
 */
export function createCliContext(session: string): SecurityContext {
  return new SecurityContext(
    createInjectionSource("cli"),
    session
  );
}

/**
 * Create a security context for daemon API calls (owner trust)
 */
export function createDaemonContext(session: string): SecurityContext {
  return new SecurityContext(
    createInjectionSource("daemon"),
    session
  );
}

/**
 * Create a security context for plugin-initiated injections
 */
export function createPluginContext(
  session: string,
  pluginName: string
): SecurityContext {
  return new SecurityContext(
    createInjectionSource("plugin", {
      identity: { pluginName },
    }),
    session
  );
}

/**
 * Create a security context for cron jobs (owner trust)
 */
export function createCronContext(session: string): SecurityContext {
  return new SecurityContext(
    createInjectionSource("cron"),
    session
  );
}

/**
 * Create a security context for P2P injections
 */
export function createP2PContext(
  session: string,
  peerKey: string,
  trustLevel: TrustLevel = "untrusted",
  grantedCapabilities?: Capability[],
  grantId?: string
): SecurityContext {
  return new SecurityContext(
    createInjectionSource("p2p", {
      trustLevel,
      identity: { publicKey: peerKey },
      grantedCapabilities,
      grantId,
    }),
    session
  );
}

/**
 * Create a security context for P2P discovered peers (always untrusted)
 */
export function createP2PDiscoveryContext(
  session: string,
  peerKey: string
): SecurityContext {
  return new SecurityContext(
    createInjectionSource("p2p.discovery", {
      trustLevel: "untrusted",
      identity: { publicKey: peerKey },
    }),
    session
  );
}

/**
 * Create a security context for API requests
 */
export function createApiContext(
  session: string,
  apiKeyId?: string,
  trustLevel: TrustLevel = "semi-trusted"
): SecurityContext {
  return new SecurityContext(
    createInjectionSource("api", {
      trustLevel,
      identity: apiKeyId ? { apiKeyId } : undefined,
    }),
    session
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `sec-${timestamp}-${random}`;
}

// ============================================================================
// Context Storage (per-request)
// ============================================================================

/**
 * Async local storage for security context
 * Allows accessing the current security context without passing it explicitly
 */
const contextStorage: Map<string, SecurityContext> = new Map();

/**
 * Store a context by session name (for current request)
 */
export function storeContext(context: SecurityContext): void {
  contextStorage.set(context.session, context);
}

/**
 * Get the current context for a session
 */
export function getContext(session: string): SecurityContext | undefined {
  return contextStorage.get(session);
}

/**
 * Clear the context for a session
 */
export function clearContext(session: string): void {
  contextStorage.delete(session);
}

/**
 * Run a function with a security context
 */
export async function withSecurityContext<T>(
  context: SecurityContext,
  fn: () => Promise<T>
): Promise<T> {
  storeContext(context);
  try {
    return await fn();
  } finally {
    clearContext(context.session);
  }
}
