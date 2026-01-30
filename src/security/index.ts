/**
 * WOPR Security Module
 *
 * Three-layer security model for session isolation:
 * - Layer 1: Trust Levels (Who) - owner, trusted, semi-trusted, untrusted
 * - Layer 2: Capabilities (What) - granular permissions
 * - Layer 3: Sandbox (Where) - Docker isolation
 */

// Export all types
export {
  // Trust levels
  type TrustLevel,
  TRUST_LEVEL_ORDER,
  compareTrustLevel,
  meetsTrustLevel,

  // Capabilities
  type Capability,
  CAPABILITY_PROFILES,
  hasCapability,
  expandCapabilities,

  // Injection source
  type InjectionSourceType,
  type InjectionSource,
  DEFAULT_TRUST_BY_SOURCE,
  createInjectionSource,

  // Sandbox
  type SandboxNetworkMode,
  type SandboxConfig,
  DEFAULT_SANDBOX_BY_TRUST,

  // Policy
  type ToolPolicy,
  type SecurityPolicy,
  type SecurityConfig,
  DEFAULT_SECURITY_CONFIG,

  // Events
  type SecurityEventType,
  type SecurityEvent,

  // Tool mapping
  TOOL_CAPABILITY_MAP,
  getToolCapability,
} from "./types.js";

// Export policy functions
export {
  initSecurity,
  getSecurityConfig,
  saveSecurityConfig,
  resolvePolicy,
  checkSessionAccess,
  checkCapability,
  checkToolAccess,
  checkSandboxRequired,
  filterToolsByPolicy,
  isEnforcementEnabled,
  shouldLogSecurityEvent,
  isGatewaySession,
  getGatewayRules,
  canGatewayForward,
  type ResolvedPolicy,
  type PolicyCheckResult,
} from "./policy.js";

// Export context functions
export {
  SecurityContext,
  createSecurityContext,
  createCliContext,
  createDaemonContext,
  createPluginContext,
  createCronContext,
  createP2PContext,
  createP2PDiscoveryContext,
  createApiContext,
  storeContext,
  getContext,
  clearContext,
  withSecurityContext,
} from "./context.js";

// Export sandbox functions
export {
  isDockerAvailable,
  isSandboxImageAvailable,
  buildSandboxImage,
  createSandbox,
  execInSandbox,
  destroySandbox,
  getSandboxStatus,
  listSandboxes,
  cleanupAllSandboxes,
} from "./sandbox.js";

// Export gateway functions
export {
  isGateway,
  getForwardRules,
  canForwardTo,
  createForwardRequest,
  validateForwardRequest,
  queueForApproval,
  approveRequest,
  rejectRequest,
  completeRequest,
  getPendingRequests,
  createForwardedContext,
  findGatewayForSource,
  requiresGateway,
  type ForwardRequest,
  type GatewayForwardRules,
} from "./gateway.js";

// Export forward functions
export {
  forwardRequest,
  executeForward,
  approveAndExecute,
  routeThroughGateway,
  handleGatewayForward,
  gatewayToolDefinitions,
  type ForwardResult,
} from "./forward.js";
