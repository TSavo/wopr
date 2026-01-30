/**
 * WOPR Session Security Model - Type Definitions
 *
 * Three-layer security model:
 * - Layer 1: Trust Levels (Who) - owner, trusted, semi-trusted, untrusted
 * - Layer 2: Capabilities (What) - granular permissions
 * - Layer 3: Sandbox (Where) - Docker isolation
 */

// ============================================================================
// Trust Levels - Who is making the request
// ============================================================================

/**
 * Trust level hierarchy (highest to lowest)
 */
export type TrustLevel = "owner" | "trusted" | "semi-trusted" | "untrusted";

/**
 * Trust level numeric values for comparison
 */
export const TRUST_LEVEL_ORDER: Record<TrustLevel, number> = {
  owner: 100,
  trusted: 75,
  "semi-trusted": 50,
  untrusted: 0,
};

/**
 * Compare two trust levels
 */
export function compareTrustLevel(a: TrustLevel, b: TrustLevel): number {
  return TRUST_LEVEL_ORDER[a] - TRUST_LEVEL_ORDER[b];
}

/**
 * Check if trust level meets minimum requirement
 */
export function meetsTrustLevel(
  actual: TrustLevel,
  required: TrustLevel
): boolean {
  return TRUST_LEVEL_ORDER[actual] >= TRUST_LEVEL_ORDER[required];
}

// ============================================================================
// Capabilities - What actions are allowed
// ============================================================================

/**
 * Granular capability permissions
 */
export type Capability =
  | "inject" // Send messages to sessions
  | "inject.tools" // Use A2A tools when injecting
  | "inject.network" // HTTP requests (http_fetch)
  | "inject.exec" // Shell commands (exec_command)
  | "session.spawn" // Create new sessions
  | "session.history" // Read own session history
  | "cross.inject" // Inject into other sessions (gateway only)
  | "cross.read" // Read other sessions' history (gateway only)
  | "config.read" // Read configuration
  | "config.write" // Modify configuration
  | "memory.read" // Read memory files
  | "memory.write" // Write memory files
  | "cron.manage" // Create/delete cron jobs
  | "event.emit" // Emit events
  | "a2a.call" // Call A2A tools in general
  | "*"; // Wildcard - all capabilities

/**
 * Capability sets for common profiles
 */
export const CAPABILITY_PROFILES: Record<string, Capability[]> = {
  owner: ["*"],
  trusted: [
    "inject",
    "inject.tools",
    "session.spawn",
    "session.history",
    "memory.read",
    "memory.write",
    "config.read",
    "event.emit",
    "a2a.call",
  ],
  "semi-trusted": [
    "inject",
    "inject.tools",
    "session.history",
    "memory.read",
    "config.read",
    "a2a.call",
  ],
  untrusted: ["inject"], // Can only send messages, no tools
  gateway: [
    "inject",
    "inject.tools",
    "cross.inject",
    "cross.read",
    "session.history",
    "memory.read",
    "a2a.call",
  ],
};

/**
 * Check if a capability set includes a specific capability
 */
export function hasCapability(
  capabilities: Capability[],
  required: Capability
): boolean {
  // Wildcard grants everything
  if (capabilities.includes("*")) {
    return true;
  }

  // Direct match
  if (capabilities.includes(required)) {
    return true;
  }

  // Check parent capabilities (e.g., "inject" grants "inject.tools")
  const parts = required.split(".");
  if (parts.length > 1) {
    const parent = parts[0] as Capability;
    if (capabilities.includes(parent)) {
      return true;
    }
  }

  return false;
}

/**
 * Expand a capability set (resolve wildcards, add implicit permissions)
 */
export function expandCapabilities(capabilities: Capability[]): Capability[] {
  if (capabilities.includes("*")) {
    return [
      "inject",
      "inject.tools",
      "inject.network",
      "inject.exec",
      "session.spawn",
      "session.history",
      "cross.inject",
      "cross.read",
      "config.read",
      "config.write",
      "memory.read",
      "memory.write",
      "cron.manage",
      "event.emit",
      "a2a.call",
      "*",
    ];
  }
  return [...new Set(capabilities)];
}

// ============================================================================
// Injection Source - Where the request came from
// ============================================================================

/**
 * Source type of an injection
 */
export type InjectionSourceType =
  | "cli" // Local CLI command
  | "daemon" // Daemon API call
  | "p2p" // P2P peer
  | "p2p.discovery" // P2P discovered peer (auto-connected)
  | "plugin" // Plugin-initiated
  | "cron" // Scheduled cron job
  | "api" // HTTP API
  | "gateway" // Forwarded from gateway session
  | "internal"; // Internal system call

/**
 * Full injection source with metadata
 */
export interface InjectionSource {
  /** Source type */
  type: InjectionSourceType;

  /** Trust level (can be explicitly set or derived from type) */
  trustLevel: TrustLevel;

  /** Identity of the source */
  identity?: {
    /** Public key for P2P sources */
    publicKey?: string;

    /** Plugin name for plugin sources */
    pluginName?: string;

    /** API key identifier for API sources */
    apiKeyId?: string;

    /** Session name for gateway forwarding */
    gatewaySession?: string;

    /** User identifier if authenticated */
    userId?: string;
  };

  /** Granted capabilities (if explicitly granted) */
  grantedCapabilities?: Capability[];

  /** Grant ID if this source has an access grant */
  grantId?: string;

  /** Timestamp of the request */
  timestamp?: number;

  /** Session this source is targeting */
  targetSession?: string;
}

/**
 * Default trust levels by source type
 */
export const DEFAULT_TRUST_BY_SOURCE: Record<InjectionSourceType, TrustLevel> =
  {
    cli: "owner",
    daemon: "owner",
    p2p: "untrusted", // P2P defaults to untrusted until granted
    "p2p.discovery": "untrusted", // Discovered peers are always untrusted
    plugin: "trusted", // Plugins are trusted by installation
    cron: "owner", // Cron jobs run as owner
    api: "semi-trusted", // API requires auth but limited scope
    gateway: "semi-trusted", // Gateway forwarded requests
    internal: "owner", // Internal calls are owner
  };

/**
 * Create an injection source with defaults
 */
export function createInjectionSource(
  type: InjectionSourceType,
  overrides?: Partial<InjectionSource>
): InjectionSource {
  return {
    type,
    trustLevel: DEFAULT_TRUST_BY_SOURCE[type],
    timestamp: Date.now(),
    ...overrides,
  };
}

// ============================================================================
// Sandbox Configuration
// ============================================================================

/**
 * Sandbox network isolation modes
 */
export type SandboxNetworkMode =
  | "none" // No network access
  | "host" // Full host network (no isolation)
  | "bridge"; // Bridged network (limited)

/**
 * Sandbox configuration for Docker isolation
 */
export interface SandboxConfig {
  /** Enable sandbox execution */
  enabled: boolean;

  /** Docker network mode */
  network: SandboxNetworkMode;

  /** Memory limit (e.g., "512m", "1g") */
  memoryLimit?: string;

  /** CPU limit (e.g., "0.5" for half a core) */
  cpuLimit?: number;

  /** PIDs limit */
  pidsLimit?: number;

  /** Timeout in seconds */
  timeout?: number;

  /** Allowed paths (read-only mounts) */
  allowedPaths?: string[];

  /** Writable paths */
  writablePaths?: string[];

  /** Environment variables to pass through */
  envPassthrough?: string[];
}

/**
 * Default sandbox configurations by trust level
 */
export const DEFAULT_SANDBOX_BY_TRUST: Record<TrustLevel, SandboxConfig> = {
  owner: {
    enabled: false,
    network: "host",
  },
  trusted: {
    enabled: false,
    network: "host",
  },
  "semi-trusted": {
    enabled: true,
    network: "bridge",
    memoryLimit: "512m",
    cpuLimit: 0.5,
    pidsLimit: 100,
    timeout: 300,
  },
  untrusted: {
    enabled: true,
    network: "none",
    memoryLimit: "256m",
    cpuLimit: 0.25,
    pidsLimit: 50,
    timeout: 60,
  },
};

// ============================================================================
// Security Policy
// ============================================================================

/**
 * Tool access policy
 */
export interface ToolPolicy {
  /** Tools explicitly allowed */
  allow?: string[];

  /** Tools explicitly denied */
  deny?: string[];
}

/**
 * Security policy for a session or source
 */
export interface SecurityPolicy {
  /** Minimum trust level required */
  minTrustLevel?: TrustLevel;

  /** Capabilities granted by this policy */
  capabilities?: Capability[];

  /** Sandbox configuration */
  sandbox?: Partial<SandboxConfig>;

  /** Tool-specific overrides */
  tools?: ToolPolicy;

  /** Rate limiting */
  rateLimit?: {
    /** Requests per minute */
    perMinute?: number;

    /** Requests per hour */
    perHour?: number;
  };

  /** Session-specific policies */
  sessions?: {
    /** Sessions this policy applies to */
    allowed?: string[];

    /** Sessions explicitly blocked */
    blocked?: string[];

    /** Gateway sessions (can receive untrusted traffic) */
    gateways?: string[];
  };
}

/**
 * Global security configuration
 */
export interface SecurityConfig {
  /** Enforcement mode */
  enforcement: "off" | "warn" | "enforce";

  /** Default policy for sources without specific config */
  defaults: SecurityPolicy;

  /** Policies by trust level */
  trustLevels?: Partial<Record<TrustLevel, SecurityPolicy>>;

  /** P2P-specific settings */
  p2p?: {
    /** Default trust level for discovered peers */
    discoveryTrust: TrustLevel;

    /** Auto-accept peer connections */
    autoAccept: boolean;

    /** Key rotation grace period in hours */
    keyRotationGraceHours?: number;

    /** Maximum payload size in bytes */
    maxPayloadSize?: number;
  };

  /** Gateway configuration */
  gateways?: {
    /** Sessions that act as gateways */
    sessions: string[];

    /** Forward rules per gateway */
    forwardRules?: Record<
      string,
      {
        allowForwardTo: string[];
        allowActions?: string[];
        requireApproval?: boolean;
        rateLimit?: { perMinute: number };
      }
    >;
  };

  /** Audit logging */
  audit?: {
    /** Enable audit logging */
    enabled: boolean;

    /** Log successful actions */
    logSuccess?: boolean;

    /** Log denied actions */
    logDenied?: boolean;

    /** Audit log path */
    logPath?: string;
  };
}

/**
 * Default security configuration
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enforcement: "warn", // Start with warnings, not blocking
  defaults: {
    minTrustLevel: "semi-trusted",
    capabilities: CAPABILITY_PROFILES["semi-trusted"],
    sandbox: { enabled: false, network: "host" },
    tools: { deny: ["config.write"] },
    rateLimit: { perMinute: 60, perHour: 1000 },
  },
  trustLevels: {
    owner: {
      capabilities: ["*"],
      sandbox: { enabled: false, network: "host" },
    },
    trusted: {
      capabilities: CAPABILITY_PROFILES["trusted"],
      sandbox: { enabled: false, network: "host" },
    },
    "semi-trusted": {
      capabilities: CAPABILITY_PROFILES["semi-trusted"],
      sandbox: { enabled: true, network: "bridge" },
      tools: { deny: ["config.write", "inject.exec"] },
    },
    untrusted: {
      capabilities: CAPABILITY_PROFILES["untrusted"],
      sandbox: { enabled: true, network: "none" },
      tools: { deny: ["*"] }, // No tools for untrusted
    },
  },
  p2p: {
    discoveryTrust: "untrusted",
    autoAccept: false,
    keyRotationGraceHours: 24,
    maxPayloadSize: 1024 * 1024, // 1MB
  },
  audit: {
    enabled: true,
    logSuccess: false,
    logDenied: true,
  },
};

// ============================================================================
// Security Events
// ============================================================================

/**
 * Security event types
 */
export type SecurityEventType =
  | "access_granted"
  | "access_denied"
  | "capability_check"
  | "sandbox_start"
  | "sandbox_stop"
  | "policy_violation"
  | "rate_limit_exceeded"
  | "trust_elevation"
  | "trust_revocation";

/**
 * Security audit event
 */
export interface SecurityEvent {
  /** Event type */
  type: SecurityEventType;

  /** Timestamp */
  timestamp: number;

  /** Injection source */
  source: InjectionSource;

  /** Target session */
  session?: string;

  /** Action attempted */
  action?: string;

  /** Tool name if applicable */
  tool?: string;

  /** Capability checked */
  capability?: Capability;

  /** Result of the check */
  allowed: boolean;

  /** Reason for denial */
  reason?: string;

  /** Additional context */
  context?: Record<string, unknown>;
}

// ============================================================================
// Tool to Capability Mapping
// ============================================================================

/**
 * Map A2A tools to required capabilities
 */
export const TOOL_CAPABILITY_MAP: Record<string, Capability> = {
  // Session tools
  sessions_list: "session.history",
  sessions_send: "cross.inject",
  sessions_history: "session.history",
  sessions_spawn: "session.spawn",

  // Config tools
  config_get: "config.read",
  config_set: "config.write",
  config_provider_defaults: "config.write",

  // Memory tools
  memory_read: "memory.read",
  memory_write: "memory.write",
  memory_search: "memory.read",
  memory_get: "memory.read",
  self_reflect: "memory.write",
  identity_get: "memory.read",
  identity_update: "memory.write",
  soul_get: "memory.read",
  soul_update: "memory.write",

  // Cron tools
  cron_schedule: "cron.manage",
  cron_once: "cron.manage",
  cron_list: "cron.manage",
  cron_cancel: "cron.manage",

  // Event tools
  event_emit: "event.emit",
  event_list: "event.emit",

  // Security introspection tools (always allowed - just show your own permissions)
  security_whoami: "inject",
  security_check: "inject",

  // Dangerous tools
  http_fetch: "inject.network",
  exec_command: "inject.exec",
  notify: "event.emit",
};

/**
 * Get required capability for a tool
 */
export function getToolCapability(toolName: string): Capability | undefined {
  return TOOL_CAPABILITY_MAP[toolName];
}
