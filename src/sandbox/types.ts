/**
 * WOPR Sandbox Types
 * Copied from OpenClaw with WOPR adaptations.
 */

import type { SandboxDockerConfig } from "./types.docker.js";

export type { SandboxDockerConfig } from "./types.docker.js";

export type SandboxToolPolicy = {
  allow?: string[];
  deny?: string[];
};

export type SandboxToolPolicySource = {
  source: "session" | "global" | "default";
  key: string;
};

export type SandboxToolPolicyResolved = {
  allow: string[];
  deny: string[];
  sources: {
    allow: SandboxToolPolicySource;
    deny: SandboxToolPolicySource;
  };
};

export type SandboxWorkspaceAccess = "none" | "ro" | "rw";

export type SandboxPruneConfig = {
  idleHours: number;
  maxAgeDays: number;
};

export type SandboxScope = "session" | "shared";

export type SandboxConfig = {
  mode: "off" | "non-main" | "all";
  scope: SandboxScope;
  workspaceAccess: SandboxWorkspaceAccess;
  workspaceRoot: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
  prune: SandboxPruneConfig;
};

export type SandboxContext = {
  enabled: boolean;
  sessionKey: string;
  workspaceDir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  containerName: string;
  containerWorkdir: string;
  docker: SandboxDockerConfig;
  tools: SandboxToolPolicy;
};

export type SandboxWorkspaceInfo = {
  workspaceDir: string;
  containerWorkdir: string;
};
