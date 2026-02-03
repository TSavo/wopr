/**
 * Docker Container Management
 * Copied from OpenClaw with WOPR adaptations.
 */

import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import type { SandboxConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
import { computeSandboxConfigHash } from "./config-hash.js";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { readRegistry, updateRegistry, findRegistryEntry } from "./registry.js";
import { resolveSandboxScopeKey, slugifySessionKey } from "./shared.js";

const HOT_CONTAINER_WINDOW_MS = 5 * 60 * 1000;

export function execDocker(
  args: string[],
  opts?: { allowFailure?: boolean }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      const exitCode = code ?? 0;
      if (exitCode !== 0 && !opts?.allowFailure) {
        reject(new Error(stderr.trim() || `docker ${args.join(" ")} failed`));
        return;
      }
      resolve({ stdout, stderr, code: exitCode });
    });
    child.on("error", (err) => {
      if (opts?.allowFailure) {
        resolve({ stdout, stderr, code: 1 });
      } else {
        reject(err);
      }
    });
  });
}

async function dockerImageExists(image: string): Promise<boolean> {
  const result = await execDocker(["image", "inspect", image], {
    allowFailure: true,
  });
  if (result.code === 0) {
    return true;
  }
  const stderr = result.stderr.trim();
  if (stderr.includes("No such image")) {
    return false;
  }
  throw new Error(`Failed to inspect sandbox image: ${stderr}`);
}

export async function ensureDockerImage(image: string): Promise<void> {
  const exists = await dockerImageExists(image);
  if (exists) {
    return;
  }
  if (image === DEFAULT_SANDBOX_IMAGE) {
    logger.info("[sandbox] Pulling debian:bookworm-slim as base image");
    await execDocker(["pull", "debian:bookworm-slim"]);
    await execDocker(["tag", "debian:bookworm-slim", DEFAULT_SANDBOX_IMAGE]);
    return;
  }
  throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}

export async function dockerContainerState(
  name: string
): Promise<{ exists: boolean; running: boolean }> {
  const result = await execDocker(["inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
  });
  if (result.code !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

function normalizeDockerLimit(value?: string | number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatUlimitValue(
  name: string,
  value: string | number | { soft?: number; hard?: number }
): string | null {
  if (!name.trim()) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string") {
    const raw = String(value).trim();
    return raw ? `${name}=${raw}` : null;
  }
  const soft = typeof value.soft === "number" ? Math.max(0, value.soft) : undefined;
  const hard = typeof value.hard === "number" ? Math.max(0, value.hard) : undefined;
  if (soft === undefined && hard === undefined) {
    return null;
  }
  if (soft === undefined) {
    return `${name}=${hard}`;
  }
  if (hard === undefined) {
    return `${name}=${soft}`;
  }
  return `${name}=${soft}:${hard}`;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  cfg: SandboxDockerConfig;
  scopeKey: string;
  createdAtMs?: number;
  labels?: Record<string, string>;
  configHash?: string;
}): string[] {
  const createdAtMs = params.createdAtMs ?? Date.now();
  const args = ["create", "--name", params.name];

  // Labels for tracking
  args.push("--label", "wopr.sandbox=1");
  args.push("--label", `wopr.sessionKey=${params.scopeKey}`);
  args.push("--label", `wopr.createdAtMs=${createdAtMs}`);
  if (params.configHash) {
    args.push("--label", `wopr.configHash=${params.configHash}`);
  }
  for (const [key, value] of Object.entries(params.labels ?? {})) {
    if (key && value) {
      args.push("--label", `${key}=${value}`);
    }
  }

  // Security settings
  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  for (const entry of params.cfg.tmpfs) {
    args.push("--tmpfs", entry);
  }
  if (params.cfg.network) {
    args.push("--network", params.cfg.network);
  }
  if (params.cfg.user) {
    args.push("--user", params.cfg.user);
  }
  for (const cap of params.cfg.capDrop) {
    args.push("--cap-drop", cap);
  }
  args.push("--security-opt", "no-new-privileges");
  if (params.cfg.seccompProfile) {
    args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
  }
  if (params.cfg.apparmorProfile) {
    args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
  }

  // DNS and hosts
  for (const entry of params.cfg.dns ?? []) {
    if (entry.trim()) {
      args.push("--dns", entry);
    }
  }
  for (const entry of params.cfg.extraHosts ?? []) {
    if (entry.trim()) {
      args.push("--add-host", entry);
    }
  }

  // Resource limits
  if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) {
    args.push("--pids-limit", String(params.cfg.pidsLimit));
  }
  const memory = normalizeDockerLimit(params.cfg.memory);
  if (memory) {
    args.push("--memory", memory);
  }
  const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
  if (memorySwap) {
    args.push("--memory-swap", memorySwap);
  }
  if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) {
    args.push("--cpus", String(params.cfg.cpus));
  }
  for (const [name, value] of Object.entries(params.cfg.ulimits ?? {}) as Array<
    [string, string | number | { soft?: number; hard?: number }]
  >) {
    const formatted = formatUlimitValue(name, value);
    if (formatted) {
      args.push("--ulimit", formatted);
    }
  }

  // Volume binds
  if (params.cfg.binds?.length) {
    for (const bind of params.cfg.binds) {
      args.push("-v", bind);
    }
  }

  return args;
}

async function createSandboxContainer(params: {
  name: string;
  cfg: SandboxDockerConfig;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  scopeKey: string;
  configHash?: string;
}): Promise<void> {
  const { name, cfg, workspaceDir, scopeKey } = params;
  await ensureDockerImage(cfg.image);

  const args = buildSandboxCreateArgs({
    name,
    cfg,
    scopeKey,
    configHash: params.configHash,
  });

  // Set workdir and mount workspace
  args.push("--workdir", cfg.workdir);
  const mountSuffix = params.workspaceAccess === "ro" ? ":ro" : "";
  args.push("-v", `${workspaceDir}:${cfg.workdir}${mountSuffix}`);

  // Image and command
  args.push(cfg.image, "sleep", "infinity");

  logger.debug(`[sandbox] Creating container: docker ${args.join(" ")}`);
  await execDocker(args);
  await execDocker(["start", name]);

  // Run setup command if specified
  if (cfg.setupCommand?.trim()) {
    logger.info(`[sandbox] Running setup command in ${name}`);
    await execDocker(["exec", "-i", name, "sh", "-lc", cfg.setupCommand]);
  }
}

async function readContainerConfigHash(containerName: string): Promise<string | null> {
  const result = await execDocker(
    ["inspect", "-f", '{{ index .Config.Labels "wopr.configHash" }}', containerName],
    { allowFailure: true }
  );
  if (result.code !== 0) {
    return null;
  }
  const raw = result.stdout.trim();
  if (!raw || raw === "<no value>") {
    return null;
  }
  return raw;
}

export async function ensureSandboxContainer(params: {
  sessionKey: string;
  workspaceDir: string;
  cfg: SandboxConfig;
}): Promise<string> {
  const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
  const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
  const name = `${params.cfg.docker.containerPrefix}${slug}`;
  const containerName = name.slice(0, 63);

  const expectedHash = computeSandboxConfigHash({
    docker: params.cfg.docker,
    workspaceAccess: params.cfg.workspaceAccess,
    workspaceDir: params.workspaceDir,
  });

  const now = Date.now();
  const state = await dockerContainerState(containerName);
  let hasContainer = state.exists;
  let running = state.running;
  let currentHash: string | null = null;
  let hashMismatch = false;
  let registryEntry: { lastUsedAtMs: number; configHash?: string } | undefined;

  if (hasContainer) {
    registryEntry = findRegistryEntry(containerName);
    currentHash = await readContainerConfigHash(containerName);
    if (!currentHash) {
      currentHash = registryEntry?.configHash ?? null;
    }
    hashMismatch = !currentHash || currentHash !== expectedHash;

    if (hashMismatch) {
      const lastUsedAtMs = registryEntry?.lastUsedAtMs;
      const isHot =
        running &&
        (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS);

      if (isHot) {
        logger.warn(
          `[sandbox] Config changed for ${containerName} (recently used). ` +
          `Run 'wopr sandbox recreate ${params.sessionKey}' to apply changes.`
        );
      } else {
        logger.info(`[sandbox] Config changed for ${containerName}, recreating...`);
        await execDocker(["rm", "-f", containerName], { allowFailure: true });
        hasContainer = false;
        running = false;
      }
    }
  }

  if (!hasContainer) {
    logger.info(`[sandbox] Creating container ${containerName} for session ${params.sessionKey}`);
    await createSandboxContainer({
      name: containerName,
      cfg: params.cfg.docker,
      workspaceDir: params.workspaceDir,
      workspaceAccess: params.cfg.workspaceAccess,
      scopeKey,
      configHash: expectedHash,
    });
  } else if (!running) {
    logger.info(`[sandbox] Starting stopped container ${containerName}`);
    await execDocker(["start", containerName]);
  }

  updateRegistry({
    containerName,
    sessionKey: scopeKey,
    createdAtMs: now,
    lastUsedAtMs: now,
    image: params.cfg.docker.image,
    configHash: hashMismatch && running ? (currentHash ?? undefined) : expectedHash,
  });

  return containerName;
}

export async function removeSandboxContainer(containerName: string): Promise<void> {
  await execDocker(["rm", "-f", containerName], { allowFailure: true });
}

export async function execInContainer(
  containerName: string,
  command: string,
  opts?: {
    workdir?: string;
    env?: Record<string, string>;
    timeout?: number;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = ["exec", "-i"];

  if (opts?.workdir) {
    args.push("-w", opts.workdir);
  }

  if (opts?.env) {
    for (const [key, value] of Object.entries(opts.env)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(containerName, "sh", "-lc", command);

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts?.timeout ? opts.timeout * 1000 : undefined,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}
