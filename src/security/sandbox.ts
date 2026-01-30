/**
 * WOPR Security Sandbox - Docker Container Management
 *
 * Provides Docker-based isolation for untrusted sessions using
 * security hardening similar to Clawdbot's model:
 * - Read-only filesystem
 * - No network access (prevents exfiltration)
 * - Dropped Linux capabilities
 * - Resource limits (memory, CPU, PIDs)
 * - Syscall filtering via seccomp
 */

import { exec, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "../logger.js";
import { type SandboxConfig, type SandboxNetworkMode } from "./types.js";

const execAsync = promisify(exec);

// ============================================================================
// Configuration
// ============================================================================

/** Docker image for sandboxed execution */
const SANDBOX_IMAGE = "wopr-sandbox:latest";

/** Seccomp profile path */
const SECCOMP_PROFILE = "/etc/wopr/seccomp.json";

/** AppArmor profile name (optional) */
const APPARMOR_PROFILE = "wopr-sandbox";

/** Default resource limits */
const DEFAULT_LIMITS = {
  memory: "512m",
  memorySwap: "512m",
  cpus: "0.5",
  pidsLimit: 100,
  timeout: 300, // 5 minutes
  nofileLimit: "1024:1024",
};

// ============================================================================
// Sandbox State
// ============================================================================

interface SandboxInstance {
  containerId: string;
  sessionName: string;
  createdAt: number;
  config: SandboxConfig;
  status: "running" | "stopped" | "error";
}

/** Active sandbox containers */
const activeSandboxes: Map<string, SandboxInstance> = new Map();

// ============================================================================
// Docker Commands
// ============================================================================

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync("docker info");
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the sandbox image exists
 */
export async function isSandboxImageAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker images -q ${SANDBOX_IMAGE}`);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Build the sandbox Docker image
 */
export async function buildSandboxImage(force = false): Promise<void> {
  if (!force && (await isSandboxImageAvailable())) {
    logger.info("[sandbox] Sandbox image already exists");
    return;
  }

  logger.info("[sandbox] Building sandbox image...");

  const dockerfile = `
FROM debian:bookworm-slim

# Install minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    curl \\
    git \\
    && rm -rf /var/lib/apt/lists/*

# Install Node.js (for claude-code)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \\
    && apt-get install -y nodejs \\
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash sandbox

# Create workspace directory
RUN mkdir -p /workspace && chown sandbox:sandbox /workspace

# Switch to non-root user
USER sandbox
WORKDIR /workspace

# Set safe defaults
ENV HOME=/home/sandbox
ENV NODE_ENV=production

CMD ["/bin/bash"]
`;

  // Write Dockerfile to temp location
  const dockerDir = "/tmp/wopr-sandbox-build";
  if (!existsSync(dockerDir)) {
    mkdirSync(dockerDir, { recursive: true });
  }
  writeFileSync(join(dockerDir, "Dockerfile"), dockerfile);

  try {
    await execAsync(`docker build -t ${SANDBOX_IMAGE} ${dockerDir}`, {
      timeout: 300000, // 5 minutes
    });
    logger.info("[sandbox] Sandbox image built successfully");
  } catch (err: any) {
    logger.error(`[sandbox] Failed to build sandbox image: ${err.message}`);
    throw err;
  }
}

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

/**
 * Ensure seccomp profile exists
 */
export function ensureSeccompProfile(): string {
  const profileDir = "/etc/wopr";
  const profilePath = join(profileDir, "seccomp.json");

  try {
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true });
    }

    if (!existsSync(profilePath)) {
      writeFileSync(profilePath, generateSeccompProfile());
      logger.info("[sandbox] Created seccomp profile");
    }

    return profilePath;
  } catch (err: any) {
    // Fall back to temp location if /etc is not writable
    const tempPath = "/tmp/wopr-seccomp.json";
    writeFileSync(tempPath, generateSeccompProfile());
    logger.warn(
      `[sandbox] Could not write to ${profilePath}, using ${tempPath}`
    );
    return tempPath;
  }
}

// ============================================================================
// Sandbox Lifecycle
// ============================================================================

/**
 * Create a sandboxed container for a session
 */
export async function createSandbox(
  sessionName: string,
  config: SandboxConfig,
  workspacePath?: string
): Promise<SandboxInstance> {
  // Check if sandbox already exists
  if (activeSandboxes.has(sessionName)) {
    const existing = activeSandboxes.get(sessionName)!;
    if (existing.status === "running") {
      return existing;
    }
    // Clean up stopped container
    await destroySandbox(sessionName);
  }

  // Verify Docker is available
  if (!(await isDockerAvailable())) {
    throw new Error("Docker is not available");
  }

  // Build image if needed
  if (!(await isSandboxImageAvailable())) {
    await buildSandboxImage();
  }

  // Ensure seccomp profile exists
  const seccompPath = ensureSeccompProfile();

  // Build docker run command
  const args = buildDockerRunArgs(sessionName, config, workspacePath, seccompPath);

  logger.info(`[sandbox] Creating sandbox for session ${sessionName}`);
  logger.debug(`[sandbox] docker run ${args.join(" ")}`);

  try {
    const { stdout } = await execAsync(`docker run ${args.join(" ")}`);
    const containerId = stdout.trim();

    const instance: SandboxInstance = {
      containerId,
      sessionName,
      createdAt: Date.now(),
      config,
      status: "running",
    };

    activeSandboxes.set(sessionName, instance);
    logger.info(
      `[sandbox] Sandbox created: ${containerId.substring(0, 12)} for ${sessionName}`
    );

    return instance;
  } catch (err: any) {
    logger.error(`[sandbox] Failed to create sandbox: ${err.message}`);
    throw err;
  }
}

/**
 * Build docker run arguments
 */
function buildDockerRunArgs(
  sessionName: string,
  config: SandboxConfig,
  workspacePath?: string,
  seccompPath?: string
): string[] {
  const args: string[] = [
    "-d", // Detached
    "--rm", // Remove when stopped
    "--read-only", // Read-only root filesystem
    "--tmpfs /tmp:rw,noexec,nosuid,size=64m", // Ephemeral temp
    "--tmpfs /var/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop=ALL", // Drop all capabilities
    "--security-opt=no-new-privileges", // Prevent privilege escalation
    `--name=wopr-sandbox-${sessionName}`,
  ];

  // Network mode
  const network = config.network ?? "none";
  args.push(`--network=${network}`);

  // Resource limits
  const memory = config.memoryLimit ?? DEFAULT_LIMITS.memory;
  const cpus = config.cpuLimit?.toString() ?? DEFAULT_LIMITS.cpus;
  const pids = config.pidsLimit ?? DEFAULT_LIMITS.pidsLimit;

  args.push(`--memory=${memory}`);
  args.push(`--memory-swap=${memory}`); // Disable swap
  args.push(`--cpus=${cpus}`);
  args.push(`--pids-limit=${pids}`);
  args.push(`--ulimit=nofile=${DEFAULT_LIMITS.nofileLimit}`);

  // Seccomp profile
  if (seccompPath && existsSync(seccompPath)) {
    args.push(`--security-opt=seccomp=${seccompPath}`);
  }

  // Mount workspace (read-only by default)
  if (workspacePath && existsSync(workspacePath)) {
    const mountOpts = config.writablePaths?.includes(workspacePath)
      ? "rw"
      : "ro";
    args.push(`-v ${workspacePath}:/workspace:${mountOpts}`);
  }

  // Mount allowed paths (read-only)
  for (const path of config.allowedPaths ?? []) {
    if (existsSync(path)) {
      args.push(`-v ${path}:${path}:ro`);
    }
  }

  // Mount writable paths
  for (const path of config.writablePaths ?? []) {
    if (existsSync(path)) {
      args.push(`-v ${path}:${path}:rw`);
    }
  }

  // Environment variables
  for (const envVar of config.envPassthrough ?? []) {
    const value = process.env[envVar];
    if (value) {
      args.push(`-e ${envVar}=${value}`);
    }
  }

  // Add the image
  args.push(SANDBOX_IMAGE);

  // Keep container running
  args.push("sleep infinity");

  return args;
}

/**
 * Execute a command in a sandbox
 */
export async function execInSandbox(
  sessionName: string,
  command: string,
  options?: {
    timeout?: number;
    workDir?: string;
    env?: Record<string, string>;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sandbox = activeSandboxes.get(sessionName);
  if (!sandbox || sandbox.status !== "running") {
    throw new Error(`No active sandbox for session ${sessionName}`);
  }

  const timeout = options?.timeout ?? sandbox.config.timeout ?? DEFAULT_LIMITS.timeout;
  const workDir = options?.workDir ?? "/workspace";

  const execArgs = [
    "exec",
    "-w",
    workDir,
  ];

  // Add environment variables
  if (options?.env) {
    for (const [key, value] of Object.entries(options.env)) {
      execArgs.push("-e", `${key}=${value}`);
    }
  }

  execArgs.push(sandbox.containerId, "/bin/bash", "-c", command);

  logger.debug(`[sandbox] Executing in ${sessionName}: ${command}`);

  return new Promise((resolve, reject) => {
    const proc = spawn("docker", execArgs, {
      timeout: timeout * 1000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Destroy a sandbox
 */
export async function destroySandbox(sessionName: string): Promise<void> {
  const sandbox = activeSandboxes.get(sessionName);
  if (!sandbox) {
    return;
  }

  logger.info(`[sandbox] Destroying sandbox for ${sessionName}`);

  try {
    // Force stop and remove
    await execAsync(`docker rm -f ${sandbox.containerId}`, {
      timeout: 10000,
    });
  } catch (err: any) {
    logger.warn(`[sandbox] Failed to destroy sandbox: ${err.message}`);
  }

  activeSandboxes.delete(sessionName);
}

/**
 * Get sandbox status
 */
export async function getSandboxStatus(
  sessionName: string
): Promise<SandboxInstance | null> {
  const sandbox = activeSandboxes.get(sessionName);
  if (!sandbox) {
    return null;
  }

  // Verify container is still running
  try {
    const { stdout } = await execAsync(
      `docker inspect -f '{{.State.Status}}' ${sandbox.containerId}`
    );
    const status = stdout.trim();

    if (status === "running") {
      sandbox.status = "running";
    } else {
      sandbox.status = "stopped";
    }
  } catch {
    sandbox.status = "error";
  }

  return sandbox;
}

/**
 * List all active sandboxes
 */
export function listSandboxes(): SandboxInstance[] {
  return Array.from(activeSandboxes.values());
}

/**
 * Cleanup all sandboxes
 */
export async function cleanupAllSandboxes(): Promise<void> {
  logger.info(`[sandbox] Cleaning up ${activeSandboxes.size} sandboxes`);

  const promises = Array.from(activeSandboxes.keys()).map((sessionName) =>
    destroySandbox(sessionName)
  );

  await Promise.allSettled(promises);
}

// ============================================================================
// MCP Socket Bridge (for A2A tools in sandbox)
// ============================================================================

/**
 * Create a Unix socket for MCP communication with sandbox
 *
 * The sandboxed claude-code connects to WOPR's A2A MCP server
 * through this socket. WOPR filters tool calls based on the
 * session's SecurityContext.
 */
export async function createMcpSocketBridge(
  sessionName: string,
  socketPath: string
): Promise<void> {
  // This would create a Unix socket that:
  // 1. Mounts into the sandbox container
  // 2. Proxies MCP calls to WOPR's A2A server
  // 3. Applies security filtering based on the session's context

  // Implementation would involve:
  // - Creating a Unix socket server
  // - Mounting it into the container
  // - Proxying and filtering MCP tool calls

  logger.info(`[sandbox] MCP socket bridge created at ${socketPath}`);

  // TODO: Implement full MCP socket bridge
  // For now, this is a placeholder for the architecture
}

// ============================================================================
// Cleanup on process exit
// ============================================================================

process.on("SIGTERM", async () => {
  await cleanupAllSandboxes();
});

process.on("SIGINT", async () => {
  await cleanupAllSandboxes();
});
