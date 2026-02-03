/**
 * WOPR Sandbox Module
 *
 * Docker-based session isolation for untrusted sessions.
 * Copied from OpenClaw with WOPR adaptations.
 */

// Types
export type {
  SandboxDockerConfig,
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxWorkspaceAccess,
  SandboxPruneConfig,
  SandboxScope,
  SandboxConfig,
  SandboxContext,
  SandboxWorkspaceInfo,
} from "./types.js";

// Constants
export {
  DEFAULT_SANDBOX_WORKSPACE_ROOT,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_WORKDIR,
  DEFAULT_SANDBOX_IDLE_HOURS,
  DEFAULT_SANDBOX_MAX_AGE_DAYS,
  DEFAULT_TOOL_ALLOW,
  DEFAULT_TOOL_DENY,
  SANDBOX_STATE_DIR,
  SANDBOX_REGISTRY_PATH,
} from "./constants.js";

// Configuration
export {
  resolveSandboxScope,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxConfig,
  shouldSandbox,
} from "./config.js";

// Registry
export type { SandboxRegistryEntry } from "./registry.js";
export {
  readRegistry,
  updateRegistry,
  removeRegistryEntry,
  findRegistryEntry,
  listRegistryEntries,
} from "./registry.js";

// Docker
export {
  execDocker,
  ensureDockerImage,
  dockerContainerState,
  buildSandboxCreateArgs,
  ensureSandboxContainer,
  removeSandboxContainer,
  execInContainer,
} from "./docker.js";

// Prune
export {
  maybePruneSandboxes,
  ensureDockerContainerIsRunning,
  pruneAllSandboxes,
} from "./prune.js";

// Tool Policy
export {
  isToolAllowed,
  resolveSandboxToolPolicy,
  filterToolsByPolicy,
} from "./tool-policy.js";

// Context
export {
  ensureSandboxWorkspace,
  resolveSandboxContext,
  getSandboxWorkspaceInfo,
} from "./context.js";

// Utilities
export {
  slugifySessionKey,
  resolveSandboxWorkspaceDir,
  resolveSandboxScopeKey,
} from "./shared.js";

export { computeSandboxConfigHash } from "./config-hash.js";
