/**
 * Sandbox Context Resolution
 * Resolves the sandbox context for a session based on security settings.
 * Adapted from OpenClaw for WOPR.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { logger } from "../logger.js";
import type { SandboxContext, SandboxWorkspaceInfo } from "./types.js";
import { resolveSandboxConfig, shouldSandbox } from "./config.js";
import { ensureSandboxContainer } from "./docker.js";
import { maybePruneSandboxes } from "./prune.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";

/**
 * Ensure the sandbox workspace directory exists and is properly initialized.
 */
export async function ensureSandboxWorkspace(workspaceDir: string): Promise<void> {
  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
  }
}

/**
 * Resolve the sandbox context for a session.
 * Returns null if sandboxing is not enabled for this session.
 */
export async function resolveSandboxContext(params: {
  sessionName: string;
  trustLevel?: string;
}): Promise<SandboxContext | null> {
  const { sessionName, trustLevel } = params;

  // Check if this session should be sandboxed
  if (!shouldSandbox({ sessionName, trustLevel })) {
    return null;
  }

  const cfg = resolveSandboxConfig({ sessionName, trustLevel });

  // Prune old containers periodically
  await maybePruneSandboxes(cfg);

  // Resolve workspace directory
  const scopeKey = resolveSandboxScopeKey(cfg.scope, sessionName);
  const workspaceDir =
    cfg.scope === "shared"
      ? cfg.workspaceRoot
      : resolveSandboxWorkspaceDir(cfg.workspaceRoot, scopeKey);

  // Ensure workspace exists
  await ensureSandboxWorkspace(workspaceDir);

  // Ensure container is running
  const containerName = await ensureSandboxContainer({
    sessionKey: sessionName,
    workspaceDir,
    cfg,
  });

  logger.info(`[sandbox] Context resolved for ${sessionName}: container=${containerName}`);

  return {
    enabled: true,
    sessionKey: sessionName,
    workspaceDir,
    workspaceAccess: cfg.workspaceAccess,
    containerName,
    containerWorkdir: cfg.docker.workdir,
    docker: cfg.docker,
    tools: cfg.tools,
  };
}

/**
 * Get the sandbox workspace info for a session without ensuring the container.
 * Useful for checking paths before full context resolution.
 */
export function getSandboxWorkspaceInfo(params: {
  sessionName: string;
  trustLevel?: string;
}): SandboxWorkspaceInfo | null {
  const { sessionName, trustLevel } = params;

  if (!shouldSandbox({ sessionName, trustLevel })) {
    return null;
  }

  const cfg = resolveSandboxConfig({ sessionName, trustLevel });
  const scopeKey = resolveSandboxScopeKey(cfg.scope, sessionName);
  const workspaceDir =
    cfg.scope === "shared"
      ? cfg.workspaceRoot
      : resolveSandboxWorkspaceDir(cfg.workspaceRoot, scopeKey);

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
