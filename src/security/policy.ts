/**
 * WOPR Security Policy Resolution
 *
 * Resolves the effective security policy for a given injection source
 * by combining global config, trust level defaults, and source-specific grants.
 */

import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "../logger.js";
import {
  type TrustLevel,
  type Capability,
  type InjectionSource,
  type SecurityPolicy,
  type SecurityConfig,
  type SandboxConfig,
  type ToolPolicy,
  DEFAULT_SECURITY_CONFIG,
  DEFAULT_SANDBOX_BY_TRUST,
  CAPABILITY_PROFILES,
  hasCapability,
  meetsTrustLevel,
  getToolCapability,
  getSessionAccess,
  matchesAnyAccessPattern,
} from "./types.js";

// ============================================================================
// Config Loading
// ============================================================================

let securityConfigPath: string | null = null;
let cachedConfig: SecurityConfig | null = null;

/**
 * Initialize security system with config path
 */
export function initSecurity(woprDir: string): void {
  securityConfigPath = join(woprDir, "security.json");
  cachedConfig = null;
}

/**
 * Get security configuration
 */
export function getSecurityConfig(): SecurityConfig {
  if (cachedConfig) return cachedConfig;

  if (securityConfigPath && existsSync(securityConfigPath)) {
    try {
      const raw = readFileSync(securityConfigPath, "utf-8");
      const loaded = JSON.parse(raw) as Partial<SecurityConfig>;
      cachedConfig = mergeConfigs(DEFAULT_SECURITY_CONFIG, loaded);
      return cachedConfig;
    } catch (err) {
      logger.warn(`[security] Failed to load security config: ${err}`);
    }
  }

  return DEFAULT_SECURITY_CONFIG;
}

/**
 * Save security configuration
 */
export function saveSecurityConfig(config: SecurityConfig): void {
  if (!securityConfigPath) {
    logger.warn("[security] Security not initialized, cannot save config");
    return;
  }

  try {
    writeFileSync(securityConfigPath, JSON.stringify(config, null, 2));
    cachedConfig = config;
    logger.info("[security] Security config saved");
  } catch (err) {
    logger.error(`[security] Failed to save security config: ${err}`);
  }
}

/**
 * Merge configs (deep merge with defaults)
 */
function mergeConfigs(
  defaults: SecurityConfig,
  overrides: Partial<SecurityConfig>
): SecurityConfig {
  return {
    ...defaults,
    ...overrides,
    defaults: {
      ...defaults.defaults,
      ...(overrides.defaults ?? {}),
    },
    trustLevels: {
      ...defaults.trustLevels,
      ...(overrides.trustLevels ?? {}),
    },
    p2p: {
      discoveryTrust: overrides.p2p?.discoveryTrust ?? defaults.p2p?.discoveryTrust ?? "untrusted",
      autoAccept: overrides.p2p?.autoAccept ?? defaults.p2p?.autoAccept ?? false,
      keyRotationGraceHours: overrides.p2p?.keyRotationGraceHours ?? defaults.p2p?.keyRotationGraceHours,
      maxPayloadSize: overrides.p2p?.maxPayloadSize ?? defaults.p2p?.maxPayloadSize,
    },
    audit: {
      enabled: overrides.audit?.enabled ?? defaults.audit?.enabled ?? false,
      logSuccess: overrides.audit?.logSuccess ?? defaults.audit?.logSuccess,
      logDenied: overrides.audit?.logDenied ?? defaults.audit?.logDenied,
      logPath: overrides.audit?.logPath ?? defaults.audit?.logPath,
    },
    gateways: overrides.gateways || defaults.gateways,
  };
}

// ============================================================================
// Policy Resolution
// ============================================================================

/**
 * Resolved policy for an injection source
 */
export interface ResolvedPolicy {
  /** Effective trust level */
  trustLevel: TrustLevel;

  /** Effective capabilities */
  capabilities: Capability[];

  /** Effective sandbox config */
  sandbox: SandboxConfig;

  /** Effective tool policy */
  tools: ToolPolicy;

  /** Rate limits */
  rateLimit: {
    perMinute: number;
    perHour: number;
  };

  /** Sessions this source can access */
  allowedSessions: string[] | "*";

  /** Sessions blocked */
  blockedSessions: string[];

  /** Is this source a gateway? */
  isGateway: boolean;

  /** Can this source forward to other sessions? */
  canForward: boolean;

  /** Forward rules if gateway */
  forwardRules?: {
    allowForwardTo: string[];
    allowActions?: string[];
    requireApproval?: boolean;
    rateLimit?: { perMinute: number };
  };
}

/**
 * Resolve the effective policy for an injection source
 */
export function resolvePolicy(
  source: InjectionSource,
  targetSession?: string
): ResolvedPolicy {
  const config = getSecurityConfig();
  const trustLevel = source.trustLevel;

  // Start with defaults
  let capabilities = [...(config.defaults.capabilities || [])];
  let sandbox: SandboxConfig = {
    ...DEFAULT_SANDBOX_BY_TRUST[trustLevel],
    ...config.defaults.sandbox,
  };
  let tools: ToolPolicy = { ...config.defaults.tools };
  let rateLimit = {
    perMinute: config.defaults.rateLimit?.perMinute || 60,
    perHour: config.defaults.rateLimit?.perHour || 1000,
  };

  // Apply trust level policy
  const trustPolicy = config.trustLevels?.[trustLevel];
  if (trustPolicy) {
    if (trustPolicy.capabilities) {
      capabilities = [...trustPolicy.capabilities];
    }
    if (trustPolicy.sandbox) {
      sandbox = { ...sandbox, ...trustPolicy.sandbox };
    }
    if (trustPolicy.tools) {
      tools = { ...tools, ...trustPolicy.tools };
    }
    if (trustPolicy.rateLimit) {
      rateLimit = { ...rateLimit, ...trustPolicy.rateLimit };
    }
  }

  // Apply source-specific granted capabilities
  if (source.grantedCapabilities) {
    // Merge granted capabilities with base capabilities
    // Granted capabilities can expand but not reduce
    for (const cap of source.grantedCapabilities) {
      if (!capabilities.includes(cap)) {
        capabilities.push(cap);
      }
    }
  }

  // Determine session access
  let allowedSessions: string[] | "*" = "*";
  let blockedSessions: string[] = [];

  if (trustPolicy?.sessions) {
    if (trustPolicy.sessions.allowed) {
      allowedSessions = trustPolicy.sessions.allowed;
    }
    if (trustPolicy.sessions.blocked) {
      blockedSessions = trustPolicy.sessions.blocked;
    }
  }

  // Check if this is a gateway session
  const isGateway =
    config.gateways?.sessions?.includes(targetSession || "") || false;
  const canForward = isGateway && hasCapability(capabilities, "cross.inject");

  // Get forward rules if gateway
  let forwardRules = undefined;
  if (isGateway && config.gateways?.forwardRules?.[targetSession || ""]) {
    forwardRules = config.gateways.forwardRules[targetSession || ""];
  }

  return {
    trustLevel,
    capabilities,
    sandbox,
    tools,
    rateLimit,
    allowedSessions,
    blockedSessions,
    isGateway,
    canForward,
    forwardRules,
  };
}

// ============================================================================
// Policy Checks
// ============================================================================

/**
 * Result of a policy check
 */
export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

/**
 * Check if a source is allowed to inject into a session
 */
export function checkSessionAccess(
  source: InjectionSource,
  session: string
): PolicyCheckResult {
  const config = getSecurityConfig();
  const policy = resolvePolicy(source, session);

  // Check minimum trust level
  if (!meetsTrustLevel(source.trustLevel, "untrusted")) {
    return {
      allowed: false,
      reason: `Trust level ${source.trustLevel} below minimum`,
    };
  }

  // Check blocked sessions (from trust level policy)
  if (policy.blockedSessions.includes(session)) {
    return {
      allowed: false,
      reason: `Session ${session} is blocked for this source`,
    };
  }

  // Check allowed sessions (from trust level policy)
  if (policy.allowedSessions !== "*") {
    if (!policy.allowedSessions.includes(session)) {
      return {
        allowed: false,
        reason: `Session ${session} not in allowed list for trust level`,
      };
    }
  }

  // Check session-level access rules (the new generic system)
  const accessPatterns = getSessionAccess(config, session);
  if (!matchesAnyAccessPattern(source, accessPatterns)) {
    return {
      allowed: false,
      reason: `Source does not match access rules for session ${session}`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a source is allowed to use a specific capability
 */
export function checkCapability(
  source: InjectionSource,
  capability: Capability,
  session?: string
): PolicyCheckResult {
  const policy = resolvePolicy(source, session);

  // Check if capability is granted
  if (!hasCapability(policy.capabilities, capability)) {
    return {
      allowed: false,
      reason: `Capability ${capability} not granted to ${source.trustLevel}`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a source is allowed to use a specific tool
 */
export function checkToolAccess(
  source: InjectionSource,
  toolName: string,
  session?: string
): PolicyCheckResult {
  const config = getSecurityConfig();
  const policy = resolvePolicy(source, session);

  // Check tool policy
  if (policy.tools.deny?.includes(toolName) || policy.tools.deny?.includes("*")) {
    // Unless explicitly allowed
    if (!policy.tools.allow?.includes(toolName)) {
      return {
        allowed: false,
        reason: `Tool ${toolName} is denied for ${source.trustLevel}`,
      };
    }
  }

  // Check capability requirement for this tool
  const requiredCap = getToolCapability(toolName);
  if (requiredCap) {
    if (!hasCapability(policy.capabilities, requiredCap)) {
      return {
        allowed: false,
        reason: `Tool ${toolName} requires capability ${requiredCap}`,
      };
    }
  }

  // Warn if enforcement is in warn mode
  if (config.enforcement === "warn") {
    return {
      allowed: true,
      warning: `Tool ${toolName} access would be denied in enforce mode`,
    };
  }

  return { allowed: true };
}

/**
 * Check if a source needs sandbox execution
 */
export function checkSandboxRequired(
  source: InjectionSource,
  session?: string
): SandboxConfig | null {
  const policy = resolvePolicy(source, session);

  if (policy.sandbox.enabled) {
    return policy.sandbox;
  }

  return null;
}

/**
 * Filter available tools based on source policy
 */
export function filterToolsByPolicy(
  source: InjectionSource,
  availableTools: string[],
  session?: string
): string[] {
  const config = getSecurityConfig();
  const policy = resolvePolicy(source, session);

  return availableTools.filter((toolName) => {
    // Check tool policy
    if (
      policy.tools.deny?.includes(toolName) ||
      policy.tools.deny?.includes("*")
    ) {
      if (!policy.tools.allow?.includes(toolName)) {
        return false;
      }
    }

    // Check capability requirement
    const requiredCap = getToolCapability(toolName);
    if (requiredCap && !hasCapability(policy.capabilities, requiredCap)) {
      // In warn mode, still include but log
      if (config.enforcement === "warn") {
        logger.warn(
          `[security] Tool ${toolName} would be denied: requires ${requiredCap}`
        );
        return true;
      }
      return false;
    }

    return true;
  });
}

// ============================================================================
// Enforcement
// ============================================================================

/**
 * Check enforcement mode
 */
export function isEnforcementEnabled(): boolean {
  const config = getSecurityConfig();
  return config.enforcement === "enforce";
}

/**
 * Check if we should log security events
 */
export function shouldLogSecurityEvent(allowed: boolean): boolean {
  const config = getSecurityConfig();
  if (!config.audit?.enabled) return false;

  if (allowed && config.audit.logSuccess) return true;
  if (!allowed && config.audit.logDenied) return true;

  return false;
}

// ============================================================================
// Session Access Helpers
// ============================================================================

/**
 * Check if a session allows untrusted access
 * (Replacement for the old isGatewaySession - sessions that allow untrusted
 * are effectively "gateways" but that's now just a configuration pattern)
 */
export function sessionAllowsUntrusted(session: string): boolean {
  const config = getSecurityConfig();
  const accessPatterns = getSessionAccess(config, session);
  // Check if any pattern would allow untrusted
  return accessPatterns.some(
    (p) => p === "*" || p === "trust:untrusted"
  );
}

/**
 * @deprecated Use sessionAllowsUntrusted or check session access rules directly
 */
export function isGatewaySession(session: string): boolean {
  const config = getSecurityConfig();
  // Legacy: check old gateways config
  if (config.gateways?.sessions?.includes(session)) {
    return true;
  }
  // New: a "gateway" is just a session that allows untrusted access
  return sessionAllowsUntrusted(session);
}

/**
 * @deprecated Configure per-session capabilities instead
 */
export function getGatewayRules(session: string): ResolvedPolicy["forwardRules"] {
  const config = getSecurityConfig();
  return config.gateways?.forwardRules?.[session];
}

/**
 * Check if a session can forward (inject) to another session
 * This replaces the gateway-specific forwarding logic with generic capability checks
 */
export function canSessionForward(
  sourceSession: string,
  targetSession: string,
  source: InjectionSource
): PolicyCheckResult {
  const config = getSecurityConfig();

  // Check if source session has cross.inject capability
  const sessionConfig = config.sessions?.[sourceSession];
  const capabilities = sessionConfig?.capabilities || [];
  if (!hasCapability(capabilities, "cross.inject")) {
    return {
      allowed: false,
      reason: `Session ${sourceSession} does not have cross.inject capability`,
    };
  }

  // Check if source can access target session (as a gateway-forwarded request)
  const forwardSource: InjectionSource = {
    ...source,
    type: "gateway",
    identity: {
      ...source.identity,
      gatewaySession: sourceSession,
    },
  };

  return checkSessionAccess(forwardSource, targetSession);
}

/**
 * @deprecated Use canSessionForward instead
 */
export function canGatewayForward(
  gatewaySession: string,
  targetSession: string,
  action?: string
): PolicyCheckResult {
  const config = getSecurityConfig();

  // Legacy: check old gateway rules
  if (config.gateways?.forwardRules?.[gatewaySession]) {
    const rules = config.gateways.forwardRules[gatewaySession];
    if (!rules.allowForwardTo.includes(targetSession) && !rules.allowForwardTo.includes("*")) {
      return {
        allowed: false,
        reason: `Gateway ${gatewaySession} cannot forward to ${targetSession}`,
      };
    }
    if (action && rules.allowActions && !rules.allowActions.includes(action)) {
      return {
        allowed: false,
        reason: `Action ${action} not allowed for gateway ${gatewaySession}`,
      };
    }
    return { allowed: true };
  }

  // New: use generic session forwarding
  const dummySource: InjectionSource = {
    type: "gateway",
    trustLevel: "semi-trusted",
    identity: { gatewaySession: gatewaySession },
  };
  return canSessionForward(gatewaySession, targetSession, dummySource);
}
