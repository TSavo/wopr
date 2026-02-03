/**
 * WOPR Security Sandbox Integration
 *
 * Bridges the sandbox module with the security model.
 * Uses Docker-based isolation for untrusted sessions.
 */

import { logger } from "../logger.js";
import type { SandboxConfig as LegacySandboxConfig } from "./types.js";
import { getContext } from "./context.js";
import {
  resolveSandboxContext,
  execInContainer,
  listRegistryEntries,
  pruneAllSandboxes,
  removeSandboxContainer,
  removeRegistryEntry,
  execDocker,
  type SandboxContext,
} from "../sandbox/index.js";

// Re-export new sandbox types
export type { SandboxContext } from "../sandbox/index.js";

// ============================================================================
// Security-Aware Sandbox Resolution
// ============================================================================

/**
 * Resolve sandbox context for a session based on its security context.
 */
export async function getSandboxForSession(
  sessionName: string
): Promise<SandboxContext | null> {
  // Get the security context for this session
  const ctx = getContext(sessionName);
  const trustLevel = ctx?.source?.trustLevel ?? "owner";

  // Resolve sandbox context based on trust level
  return resolveSandboxContext({
    sessionName,
    trustLevel,
  });
}

/**
 * Execute a command in a session's sandbox.
 * If the session is not sandboxed, returns null.
 */
export async function execInSandbox(
  sessionName: string,
  command: string,
  options?: {
    timeout?: number;
    workDir?: string;
    env?: Record<string, string>;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  const sandbox = await getSandboxForSession(sessionName);
  if (!sandbox) {
    return null; // Not sandboxed
  }

  return execInContainer(sandbox.containerName, command, {
    workdir: options?.workDir ?? sandbox.containerWorkdir,
    env: options?.env,
    timeout: options?.timeout,
  });
}

/**
 * Check if a session is sandboxed.
 */
export async function isSessionSandboxed(sessionName: string): Promise<boolean> {
  const sandbox = await getSandboxForSession(sessionName);
  return sandbox !== null;
}

// ============================================================================
// Legacy API (for backwards compatibility with existing security/sandbox.ts)
// ============================================================================

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const result = await execDocker(["info"], { allowFailure: true });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * Check if the sandbox image exists
 */
export async function isSandboxImageAvailable(): Promise<boolean> {
  try {
    const { listRegistryEntries } = await import("../sandbox/index.js");
    const entries = listRegistryEntries();
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the sandbox Docker image
 */
export async function buildSandboxImage(force = false): Promise<void> {
  const { ensureDockerImage, DEFAULT_SANDBOX_IMAGE } = await import("../sandbox/index.js");
  await ensureDockerImage(DEFAULT_SANDBOX_IMAGE);
}

/**
 * Create a sandboxed container for a session (legacy API)
 */
export async function createSandbox(
  sessionName: string,
  config: LegacySandboxConfig,
  workspacePath?: string
): Promise<{ containerId: string; sessionName: string; status: string }> {
  const sandbox = await getSandboxForSession(sessionName);
  if (!sandbox) {
    throw new Error("Session is not configured for sandboxing");
  }

  return {
    containerId: sandbox.containerName,
    sessionName,
    status: "running",
  };
}

/**
 * Destroy a sandbox (legacy API)
 */
export async function destroySandbox(sessionName: string): Promise<void> {
  const entries = listRegistryEntries();
  const entry = entries.find((e) => e.sessionKey === sessionName);
  if (entry) {
    await removeSandboxContainer(entry.containerName);
    removeRegistryEntry(entry.containerName);
  }
}

/**
 * Get sandbox status (legacy API)
 */
export async function getSandboxStatus(
  sessionName: string
): Promise<{ containerId: string; sessionName: string; status: string } | null> {
  const sandbox = await getSandboxForSession(sessionName);
  if (!sandbox) {
    return null;
  }
  return {
    containerId: sandbox.containerName,
    sessionName,
    status: "running",
  };
}

/**
 * List all active sandboxes (legacy API)
 */
export function listSandboxes(): Array<{
  containerId: string;
  sessionName: string;
  createdAt: number;
  status: string;
}> {
  const entries = listRegistryEntries();
  return entries.map((e) => ({
    containerId: e.containerName,
    sessionName: e.sessionKey,
    createdAt: e.createdAtMs,
    status: "running",
  }));
}

/**
 * Cleanup all sandboxes
 */
export async function cleanupAllSandboxes(): Promise<void> {
  logger.info("[sandbox] Cleaning up all sandboxes");
  await pruneAllSandboxes();
}

// ============================================================================
// Seccomp Profile (kept for reference, but Docker defaults are usually fine)
// ============================================================================

/**
 * Generate seccomp profile for sandboxing
 */
export function generateSeccompProfile(): string {
  // Minimal seccomp profile that blocks dangerous syscalls
  const profile = {
    defaultAction: "SCMP_ACT_ALLOW",
    syscalls: [
      // Block process creation (anti-fork bomb)
      {
        names: ["clone", "clone3", "fork", "vfork"],
        action: "SCMP_ACT_ERRNO",
        args: [],
      },
      // Block network operations (prevent exfiltration)
      {
        names: ["socket", "connect", "bind", "listen", "accept", "accept4"],
        action: "SCMP_ACT_ERRNO",
        args: [],
      },
      // Block mounting (prevent escape)
      {
        names: ["mount", "umount", "umount2", "pivot_root"],
        action: "SCMP_ACT_ERRNO",
        args: [],
      },
      // Block kernel module loading
      {
        names: ["init_module", "finit_module", "delete_module"],
        action: "SCMP_ACT_ERRNO",
        args: [],
      },
      // Block dangerous system calls
      {
        names: [
          "reboot",
          "sethostname",
          "setdomainname",
          "kexec_load",
          "kexec_file_load",
        ],
        action: "SCMP_ACT_ERRNO",
        args: [],
      },
    ],
  };

  return JSON.stringify(profile, null, 2);
}

// Keep MCP socket bridge placeholder for future
export async function createMcpSocketBridge(
  sessionName: string,
  socketPath: string
): Promise<void> {
  logger.info(`[sandbox] MCP socket bridge placeholder at ${socketPath}`);
  // TODO: Implement full MCP socket bridge
}

// Cleanup on process exit
process.on("SIGTERM", async () => {
  await cleanupAllSandboxes();
});

process.on("SIGINT", async () => {
  await cleanupAllSandboxes();
});
