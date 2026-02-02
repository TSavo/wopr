/**
 * WOPR Plugin Requirements Checker & Auto-Installer
 *
 * Based on clawdbot's skills requirements system.
 * Checks required binaries, env vars, docker images, and config paths.
 * Can auto-install missing dependencies via brew, apt, pip, npm, docker, etc.
 */

import { execSync, spawn } from "child_process";
import { accessSync, constants } from "fs";
import { join, delimiter } from "path";
import { logger } from "../logger.js";
import type { InstallMethod, VoicePluginRequirements } from "../voice/types.js";

// =============================================================================
// Requirement Check Results
// =============================================================================

export interface RequirementCheckResult {
  satisfied: boolean;
  missing: {
    bins: string[];
    env: string[];
    docker: string[];
    config: string[];
  };
  available: {
    bins: string[];
    env: string[];
    docker: string[];
    config: string[];
  };
}

export interface InstallResult {
  ok: boolean;
  method: InstallMethod;
  message: string;
  stdout?: string;
  stderr?: string;
}

// =============================================================================
// Binary Checking (from clawdbot src/agents/skills/config.ts)
// =============================================================================

/**
 * Check if a binary exists in PATH
 */
export function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(delimiter).filter(Boolean);

  for (const part of parts) {
    const candidate = join(part, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

/**
 * Get the path to a binary if it exists
 */
export function whichBinary(bin: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(delimiter).filter(Boolean);

  for (const part of parts) {
    const candidate = join(part, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep scanning
    }
  }
  return null;
}

// =============================================================================
// Environment Variable Checking
// =============================================================================

/**
 * Check if an environment variable is set and non-empty
 */
export function hasEnv(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0;
}

// =============================================================================
// Docker Image Checking (from clawdbot src/commands/doctor-sandbox.ts)
// =============================================================================

/**
 * Check if Docker is available
 */
export function hasDocker(): boolean {
  return hasBinary("docker");
}

/**
 * Check if a Docker image exists locally
 */
export async function dockerImageExists(image: string): Promise<boolean> {
  if (!hasDocker()) return false;

  try {
    execSync(`docker image inspect ${image}`, {
      timeout: 5000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image
 */
export async function dockerPull(image: string, tag?: string): Promise<InstallResult> {
  const fullImage = tag ? `${image}:${tag}` : image;

  return new Promise((resolve) => {
    const proc = spawn("docker", ["pull", fullImage], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      const line = data.toString();
      stdout += line;
      // Log progress
      if (line.includes("Pulling") || line.includes("Downloaded") || line.includes("Pull complete")) {
        logger.info(`[docker] ${line.trim()}`);
      }
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        ok: code === 0,
        method: { kind: "docker", image, tag },
        message: code === 0 ? `Pulled ${fullImage}` : `Failed to pull ${fullImage}`,
        stdout,
        stderr,
      });
    });

    proc.on("error", (err) => {
      resolve({
        ok: false,
        method: { kind: "docker", image, tag },
        message: `Docker pull error: ${err.message}`,
        stderr: err.message,
      });
    });
  });
}

// =============================================================================
// Config Path Checking
// =============================================================================

/**
 * Resolve a dot-notation config path
 */
export function resolveConfigPath(config: Record<string, unknown> | undefined, pathStr: string): unknown {
  if (!config) return undefined;

  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;

  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Check if a config path is truthy
 */
export function isConfigPathTruthy(config: Record<string, unknown> | undefined, pathStr: string): boolean {
  const value = resolveConfigPath(config, pathStr);
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

// =============================================================================
// Comprehensive Requirements Checking
// =============================================================================

/**
 * Check all requirements for a plugin
 */
export async function checkRequirements(
  requires: VoicePluginRequirements | undefined,
  config?: Record<string, unknown>,
): Promise<RequirementCheckResult> {
  const result: RequirementCheckResult = {
    satisfied: true,
    missing: { bins: [], env: [], docker: [], config: [] },
    available: { bins: [], env: [], docker: [], config: [] },
  };

  if (!requires) return result;

  // Check binaries
  for (const bin of requires.bins ?? []) {
    if (hasBinary(bin)) {
      result.available.bins.push(bin);
    } else {
      result.missing.bins.push(bin);
      result.satisfied = false;
    }
  }

  // Check environment variables
  for (const env of requires.env ?? []) {
    if (hasEnv(env)) {
      result.available.env.push(env);
    } else {
      result.missing.env.push(env);
      result.satisfied = false;
    }
  }

  // Check Docker images
  for (const image of requires.docker ?? []) {
    if (await dockerImageExists(image)) {
      result.available.docker.push(image);
    } else {
      result.missing.docker.push(image);
      result.satisfied = false;
    }
  }

  // Check config paths
  for (const path of requires.config ?? []) {
    if (isConfigPathTruthy(config, path)) {
      result.available.config.push(path);
    } else {
      result.missing.config.push(path);
      result.satisfied = false;
    }
  }

  return result;
}

// =============================================================================
// Installation Methods (from clawdbot src/agents/skills-install.ts)
// =============================================================================

/**
 * Run an install command with timeout
 */
async function runInstallCommand(
  argv: string[],
  timeoutMs = 300000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const proc = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, code });
    });

    proc.on("error", (err) => {
      resolve({ ok: false, stdout, stderr: err.message, code: null });
    });
  });
}

/**
 * Execute an install method
 */
export async function runInstall(method: InstallMethod): Promise<InstallResult> {
  logger.info(`[install] Running ${method.kind} install...`);

  switch (method.kind) {
    case "brew": {
      if (!hasBinary("brew")) {
        return {
          ok: false,
          method,
          message: "Homebrew not installed",
        };
      }
      const result = await runInstallCommand(["brew", "install", method.formula]);
      return {
        ok: result.ok,
        method,
        message: result.ok ? `Installed ${method.formula}` : `Failed to install ${method.formula}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    case "apt": {
      if (!hasBinary("apt-get")) {
        return {
          ok: false,
          method,
          message: "apt-get not available (not a Debian-based system)",
        };
      }
      // Note: May need sudo
      const result = await runInstallCommand(["sudo", "apt-get", "install", "-y", method.package]);
      return {
        ok: result.ok,
        method,
        message: result.ok ? `Installed ${method.package}` : `Failed to install ${method.package}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    case "pip": {
      const pip = hasBinary("pip3") ? "pip3" : hasBinary("pip") ? "pip" : null;
      if (!pip) {
        return {
          ok: false,
          method,
          message: "pip not installed",
        };
      }
      const result = await runInstallCommand([pip, "install", method.package]);
      return {
        ok: result.ok,
        method,
        message: result.ok ? `Installed ${method.package}` : `Failed to install ${method.package}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    case "npm": {
      const npm = hasBinary("pnpm") ? "pnpm" : hasBinary("npm") ? "npm" : null;
      if (!npm) {
        return {
          ok: false,
          method,
          message: "npm/pnpm not installed",
        };
      }
      const result = await runInstallCommand([npm, "install", "-g", method.package]);
      return {
        ok: result.ok,
        method,
        message: result.ok ? `Installed ${method.package}` : `Failed to install ${method.package}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    case "docker": {
      return dockerPull(method.image, method.tag);
    }

    case "script": {
      // Download and run script (dangerous - require explicit approval)
      return {
        ok: false,
        method,
        message: "Script installation requires manual approval",
      };
    }

    case "manual": {
      return {
        ok: false,
        method,
        message: `Manual installation required: ${method.instructions}`,
      };
    }

    default:
      return {
        ok: false,
        method,
        message: "Unknown install method",
      };
  }
}

// =============================================================================
// Auto-Install Orchestration
// =============================================================================

export interface AutoInstallOptions {
  /** Automatically install without prompting */
  auto?: boolean;
  /** Prompt function for interactive mode */
  prompt?: (message: string) => Promise<boolean>;
  /** Skip specific install kinds */
  skip?: Array<InstallMethod["kind"]>;
}

/**
 * Check requirements and optionally auto-install missing dependencies
 */
export async function ensureRequirements(
  requires: VoicePluginRequirements | undefined,
  installMethods: InstallMethod[] | undefined,
  options: AutoInstallOptions = {},
): Promise<{ satisfied: boolean; installed: InstallResult[]; errors: string[] }> {
  const check = await checkRequirements(requires);

  if (check.satisfied) {
    return { satisfied: true, installed: [], errors: [] };
  }

  // Log what's missing
  if (check.missing.bins.length > 0) {
    logger.warn(`[requirements] Missing binaries: ${check.missing.bins.join(", ")}`);
  }
  if (check.missing.env.length > 0) {
    logger.warn(`[requirements] Missing env vars: ${check.missing.env.join(", ")}`);
  }
  if (check.missing.docker.length > 0) {
    logger.warn(`[requirements] Missing Docker images: ${check.missing.docker.join(", ")}`);
  }
  if (check.missing.config.length > 0) {
    logger.warn(`[requirements] Missing config: ${check.missing.config.join(", ")}`);
  }

  // If no install methods provided, can't auto-install
  if (!installMethods || installMethods.length === 0) {
    return {
      satisfied: false,
      installed: [],
      errors: ["No install methods provided for missing dependencies"],
    };
  }

  const installed: InstallResult[] = [];
  const errors: string[] = [];

  // Try each install method
  for (const method of installMethods) {
    // Skip if this kind is excluded
    if (options.skip?.includes(method.kind)) {
      continue;
    }

    // Check if this method can help with missing deps
    const canHelp = canMethodHelp(method, check.missing);
    if (!canHelp) continue;

    // Prompt if not auto mode
    if (!options.auto && options.prompt) {
      const label = method.label || `Install via ${method.kind}`;
      const approved = await options.prompt(`${label}?`);
      if (!approved) continue;
    }

    // Run the install
    const result = await runInstall(method);
    installed.push(result);

    if (!result.ok) {
      errors.push(result.message);
    } else {
      logger.info(`[requirements] ${result.message}`);
    }
  }

  // Re-check requirements
  const recheck = await checkRequirements(requires);

  return {
    satisfied: recheck.satisfied,
    installed,
    errors,
  };
}

/**
 * Check if an install method can help with missing requirements
 */
function canMethodHelp(
  method: InstallMethod,
  missing: RequirementCheckResult["missing"],
): boolean {
  switch (method.kind) {
    case "brew":
    case "apt":
    case "pip":
    case "npm":
      // These install binaries
      return missing.bins.length > 0;

    case "docker":
      // Check if this image is in the missing list
      const fullImage = method.tag ? `${method.image}:${method.tag}` : method.image;
      return missing.docker.some(
        (img) => img === fullImage || img === method.image || img.startsWith(`${method.image}:`),
      );

    case "script":
    case "manual":
      // Could help with anything
      return true;

    default:
      return false;
  }
}

// =============================================================================
// Utility: Format Requirements for Display
// =============================================================================

export function formatMissingRequirements(check: RequirementCheckResult): string {
  const lines: string[] = [];

  if (check.missing.bins.length > 0) {
    lines.push(`  Binaries: ${check.missing.bins.join(", ")}`);
  }
  if (check.missing.env.length > 0) {
    lines.push(`  Environment: ${check.missing.env.join(", ")}`);
  }
  if (check.missing.docker.length > 0) {
    lines.push(`  Docker images: ${check.missing.docker.join(", ")}`);
  }
  if (check.missing.config.length > 0) {
    lines.push(`  Config: ${check.missing.config.join(", ")}`);
  }

  return lines.length > 0 ? `Missing requirements:\n${lines.join("\n")}` : "All requirements satisfied";
}
