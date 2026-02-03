/**
 * Sandbox Configuration Resolution
 * Resolves sandbox config from WOPR config and security model.
 * Adapted from OpenClaw for WOPR.
 */

import { config as woprConfig } from "../core/config.js";
import type {
  SandboxConfig,
  SandboxDockerConfig,
  SandboxPruneConfig,
  SandboxScope,
  SandboxWorkspaceAccess,
} from "./types.js";
import {
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IDLE_HOURS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_MAX_AGE_DAYS,
  DEFAULT_SANDBOX_WORKDIR,
  DEFAULT_SANDBOX_WORKSPACE_ROOT,
  DEFAULT_TOOL_ALLOW,
  DEFAULT_TOOL_DENY,
} from "./constants.js";

/**
 * Get sandbox config from WOPR config.
 */
function getWoprSandboxConfig(): Partial<SandboxConfig> | undefined {
  return (woprConfig as any).sandbox;
}

export function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) {
    return params.scope;
  }
  if (typeof params.perSession === "boolean") {
    return params.perSession ? "session" : "shared";
  }
  return "session"; // WOPR default: per-session isolation
}

export function resolveSandboxDockerConfig(params: {
  globalDocker?: Partial<SandboxDockerConfig>;
  sessionDocker?: Partial<SandboxDockerConfig>;
}): SandboxDockerConfig {
  const global = params.globalDocker;
  const session = params.sessionDocker;

  const env = session?.env
    ? { ...(global?.env ?? { LANG: "C.UTF-8" }), ...session.env }
    : global?.env ?? { LANG: "C.UTF-8" };

  const ulimits = session?.ulimits
    ? { ...global?.ulimits, ...session.ulimits }
    : global?.ulimits;

  const binds = [...(global?.binds ?? []), ...(session?.binds ?? [])];

  return {
    image: session?.image ?? global?.image ?? DEFAULT_SANDBOX_IMAGE,
    containerPrefix: session?.containerPrefix ?? global?.containerPrefix ?? DEFAULT_SANDBOX_CONTAINER_PREFIX,
    workdir: session?.workdir ?? global?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
    readOnlyRoot: session?.readOnlyRoot ?? global?.readOnlyRoot ?? true,
    tmpfs: session?.tmpfs ?? global?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
    network: session?.network ?? global?.network ?? "none",
    user: session?.user ?? global?.user,
    capDrop: session?.capDrop ?? global?.capDrop ?? ["ALL"],
    env,
    setupCommand: session?.setupCommand ?? global?.setupCommand,
    pidsLimit: session?.pidsLimit ?? global?.pidsLimit ?? 100,
    memory: session?.memory ?? global?.memory ?? "512m",
    memorySwap: session?.memorySwap ?? global?.memorySwap ?? "512m",
    cpus: session?.cpus ?? global?.cpus ?? 0.5,
    ulimits,
    seccompProfile: session?.seccompProfile ?? global?.seccompProfile,
    apparmorProfile: session?.apparmorProfile ?? global?.apparmorProfile,
    dns: session?.dns ?? global?.dns,
    extraHosts: session?.extraHosts ?? global?.extraHosts,
    binds: binds.length ? binds : undefined,
  };
}

export function resolveSandboxPruneConfig(params: {
  globalPrune?: Partial<SandboxPruneConfig>;
  sessionPrune?: Partial<SandboxPruneConfig>;
}): SandboxPruneConfig {
  const global = params.globalPrune;
  const session = params.sessionPrune;
  return {
    idleHours: session?.idleHours ?? global?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
    maxAgeDays: session?.maxAgeDays ?? global?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
  };
}

/**
 * Resolve the complete sandbox configuration for a session.
 */
export function resolveSandboxConfig(params?: {
  sessionName?: string;
  trustLevel?: string;
}): SandboxConfig {
  const woprSandbox = getWoprSandboxConfig();

  // Determine mode based on trust level
  let mode: SandboxConfig["mode"] = woprSandbox?.mode ?? "off";
  if (params?.trustLevel === "untrusted" || params?.trustLevel === "semi-trusted") {
    // Force sandbox for untrusted sources
    mode = "all";
  }

  const scope = resolveSandboxScope({
    scope: woprSandbox?.scope,
  });

  // Determine workspace access based on trust level
  let workspaceAccess: SandboxWorkspaceAccess = woprSandbox?.workspaceAccess ?? "none";
  if (params?.trustLevel === "untrusted") {
    // Untrusted sessions get no workspace access
    workspaceAccess = "none";
  } else if (params?.trustLevel === "semi-trusted") {
    // Semi-trusted get read-only
    workspaceAccess = "ro";
  }

  return {
    mode,
    scope,
    workspaceAccess,
    workspaceRoot: woprSandbox?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
    docker: resolveSandboxDockerConfig({
      globalDocker: woprSandbox?.docker,
    }),
    tools: {
      allow: woprSandbox?.tools?.allow ?? [...DEFAULT_TOOL_ALLOW],
      deny: woprSandbox?.tools?.deny ?? [...DEFAULT_TOOL_DENY],
    },
    prune: resolveSandboxPruneConfig({
      globalPrune: woprSandbox?.prune,
    }),
  };
}

/**
 * Check if a session should be sandboxed.
 */
export function shouldSandbox(params: {
  sessionName: string;
  trustLevel?: string;
}): boolean {
  const cfg = resolveSandboxConfig(params);

  if (cfg.mode === "off") {
    return false;
  }

  if (cfg.mode === "all") {
    return true;
  }

  // mode === "non-main" - sandbox all except "main" session
  return params.sessionName !== "main";
}
