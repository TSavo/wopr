/**
 * Step 2b: Sandbox configuration
 * Checks Docker availability and configures sandboxing for untrusted sessions.
 */
import { confirm, select, note, spinner, pc } from "../prompts.js";
import type { OnboardContext, OnboardStep } from "../types.js";

async function checkDockerAvailable(): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function checkSandboxImageExists(): Promise<boolean> {
  try {
    const { execSync } = await import("child_process");
    const result = execSync("docker images wopr-sandbox:bookworm-slim -q", {
      encoding: "utf-8",
    });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

async function buildSandboxImage(): Promise<boolean> {
  try {
    const { ensureDockerImage, DEFAULT_SANDBOX_IMAGE } = await import(
      "../../../sandbox/index.js"
    );
    await ensureDockerImage(DEFAULT_SANDBOX_IMAGE);
    return true;
  } catch {
    return false;
  }
}

export const sandboxStep: OnboardStep = async (ctx: OnboardContext) => {
  // Check if Docker is available
  const dockerAvailable = await checkDockerAvailable();

  if (!dockerAvailable) {
    await note(
      [
        "Docker is not available on this system.",
        "",
        "Sandboxing provides isolation for untrusted sessions by running",
        "commands in Docker containers. Without Docker:",
        "",
        "  • All commands run directly on the host",
        "  • Untrusted sessions (P2P, API) have same access as main",
        "",
        pc.dim("Install Docker to enable sandboxing: https://docs.docker.com/get-docker/"),
      ].join("\n"),
      "Sandbox Unavailable"
    );

    return {
      sandbox: {
        enabled: false,
        mode: "off",
      },
    };
  }

  // Docker is available - offer sandbox configuration
  await note(
    [
      "Docker is available for sandboxing.",
      "",
      "Sandboxing runs commands from untrusted sessions (P2P peers, API",
      "clients) in isolated Docker containers with:",
      "",
      "  • No network access",
      "  • Read-only filesystem",
      "  • Resource limits (CPU, memory)",
      "  • Blocked dangerous commands",
    ].join("\n"),
    "Sandbox Available"
  );

  // Skip sandbox in quickstart mode - just enable by default
  if (ctx.opts.flow === "quickstart") {
    // Check/build image silently
    const imageExists = await checkSandboxImageExists();
    if (!imageExists) {
      const s = await spinner();
      s.start("Building sandbox Docker image...");
      const built = await buildSandboxImage();
      if (built) {
        s.stop("Sandbox image built");
      } else {
        s.stop("Sandbox image build failed (can be built later)");
      }
    }

    return {
      sandbox: {
        enabled: true,
        mode: "non-main",
        workspaceAccess: "ro",
      },
    };
  }

  // Advanced mode - ask user
  const enableSandbox = await confirm({
    message: "Enable sandboxing for untrusted sessions?",
    initialValue: true,
  });

  if (!enableSandbox) {
    return {
      sandbox: {
        enabled: false,
        mode: "off",
      },
    };
  }

  // Check if image exists, offer to build
  const imageExists = await checkSandboxImageExists();
  if (!imageExists) {
    const buildNow = await confirm({
      message: "Sandbox Docker image not found. Build it now?",
      initialValue: true,
    });

    if (buildNow) {
      const s = await spinner();
      s.start("Building sandbox Docker image (this may take a minute)...");
      const built = await buildSandboxImage();
      if (built) {
        s.stop("Sandbox image built successfully");
      } else {
        s.stop(pc.yellow("Sandbox image build failed - can retry with: wopr sandbox build"));
      }
    }
  }

  // Ask about sandbox mode
  const mode = await select({
    message: "Which sessions should be sandboxed?",
    options: [
      {
        value: "non-main",
        label: "Non-main sessions (recommended)",
        hint: "P2P, API, cron - but not CLI main session",
      },
      {
        value: "all",
        label: "All sessions",
        hint: "Maximum isolation, including CLI main session",
      },
    ],
    initialValue: "non-main",
  });

  // Ask about workspace access
  const workspaceAccess = await select({
    message: "Workspace access for sandboxed sessions?",
    options: [
      {
        value: "ro",
        label: "Read-only (recommended)",
        hint: "Can read files but not modify",
      },
      {
        value: "none",
        label: "No access",
        hint: "Maximum isolation, no file access",
      },
      {
        value: "rw",
        label: "Read-write",
        hint: "Full access (less secure)",
      },
    ],
    initialValue: "ro",
  });

  return {
    sandbox: {
      enabled: true,
      mode: mode as "non-main" | "all",
      workspaceAccess: workspaceAccess as "none" | "ro" | "rw",
    },
  };
};
