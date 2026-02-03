/**
 * Sandbox Container Registry
 * Tracks container state persistently across restarts.
 * Copied from OpenClaw with WOPR adaptations.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { SANDBOX_REGISTRY_PATH, SANDBOX_STATE_DIR } from "./constants.js";

export type SandboxRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export function readRegistry(): SandboxRegistry {
  try {
    if (!existsSync(SANDBOX_REGISTRY_PATH)) {
      return { entries: [] };
    }
    const raw = readFileSync(SANDBOX_REGISTRY_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SandboxRegistry;
    if (parsed && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return { entries: [] };
}

function writeRegistry(registry: SandboxRegistry): void {
  if (!existsSync(SANDBOX_STATE_DIR)) {
    mkdirSync(SANDBOX_STATE_DIR, { recursive: true });
  }
  writeFileSync(SANDBOX_REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

export function updateRegistry(entry: SandboxRegistryEntry): void {
  const registry = readRegistry();
  const existing = registry.entries.find((item) => item.containerName === entry.containerName);
  const next = registry.entries.filter((item) => item.containerName !== entry.containerName);
  next.push({
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
  });
  writeRegistry({ entries: next });
}

export function removeRegistryEntry(containerName: string): void {
  const registry = readRegistry();
  const next = registry.entries.filter((item) => item.containerName !== containerName);
  if (next.length === registry.entries.length) {
    return;
  }
  writeRegistry({ entries: next });
}

export function findRegistryEntry(containerName: string): SandboxRegistryEntry | undefined {
  const registry = readRegistry();
  return registry.entries.find((item) => item.containerName === containerName);
}

export function listRegistryEntries(): SandboxRegistryEntry[] {
  return readRegistry().entries;
}
