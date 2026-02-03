/**
 * Sandbox Container Pruning
 * Automatic cleanup of idle and old containers.
 * Copied from OpenClaw with WOPR adaptations.
 */

import { logger } from "../logger.js";
import type { SandboxConfig } from "./types.js";
import { dockerContainerState, execDocker } from "./docker.js";
import { readRegistry, removeRegistryEntry } from "./registry.js";

let lastPruneAtMs = 0;

async function pruneSandboxContainers(cfg: SandboxConfig): Promise<void> {
  const now = Date.now();
  const idleHours = cfg.prune.idleHours;
  const maxAgeDays = cfg.prune.maxAgeDays;

  if (idleHours === 0 && maxAgeDays === 0) {
    return;
  }

  const registry = readRegistry();
  for (const entry of registry.entries) {
    const idleMs = now - entry.lastUsedAtMs;
    const ageMs = now - entry.createdAtMs;

    if (
      (idleHours > 0 && idleMs > idleHours * 60 * 60 * 1000) ||
      (maxAgeDays > 0 && ageMs > maxAgeDays * 24 * 60 * 60 * 1000)
    ) {
      logger.info(`[sandbox] Pruning idle container: ${entry.containerName}`);
      try {
        await execDocker(["rm", "-f", entry.containerName], {
          allowFailure: true,
        });
      } catch {
        // ignore prune failures
      } finally {
        removeRegistryEntry(entry.containerName);
      }
    }
  }
}

export async function maybePruneSandboxes(cfg: SandboxConfig): Promise<void> {
  const now = Date.now();
  // Only prune once every 5 minutes
  if (now - lastPruneAtMs < 5 * 60 * 1000) {
    return;
  }
  lastPruneAtMs = now;

  try {
    await pruneSandboxContainers(cfg);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[sandbox] Prune failed: ${message}`);
  }
}

export async function ensureDockerContainerIsRunning(containerName: string): Promise<void> {
  const state = await dockerContainerState(containerName);
  if (state.exists && !state.running) {
    await execDocker(["start", containerName]);
  }
}

export async function pruneAllSandboxes(): Promise<number> {
  const registry = readRegistry();
  let pruned = 0;

  for (const entry of registry.entries) {
    try {
      await execDocker(["rm", "-f", entry.containerName], { allowFailure: true });
      removeRegistryEntry(entry.containerName);
      pruned++;
    } catch {
      // ignore
    }
  }

  return pruned;
}
