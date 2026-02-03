/**
 * Sandbox Tool Policy
 * Controls which tools are allowed in sandboxed sessions.
 * Copied from OpenClaw with WOPR adaptations.
 */

import type { SandboxToolPolicy, SandboxToolPolicyResolved, SandboxToolPolicySource } from "./types.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./constants.js";

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function compilePattern(pattern: string): CompiledPattern {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  if (normalized === "*") {
    return { kind: "all" };
  }
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "regex",
    value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`),
  };
}

function compilePatterns(patterns?: string[]): CompiledPattern[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return patterns
    .map(compilePattern)
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}

function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return true;
    }
    if (pattern.kind === "exact" && name === pattern.value) {
      return true;
    }
    if (pattern.kind === "regex" && pattern.value.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a tool is allowed by the sandbox policy.
 */
export function isToolAllowed(policy: SandboxToolPolicy, name: string): boolean {
  const normalized = name.trim().toLowerCase();

  // Check deny list first
  const deny = compilePatterns(policy.deny);
  if (matchesAny(normalized, deny)) {
    return false;
  }

  // Check allow list (if empty, allow all not denied)
  const allow = compilePatterns(policy.allow);
  if (allow.length === 0) {
    return true;
  }

  return matchesAny(normalized, allow);
}

/**
 * Resolve the effective tool policy for a session.
 */
export function resolveSandboxToolPolicy(params: {
  sessionPolicy?: SandboxToolPolicy;
  globalPolicy?: SandboxToolPolicy;
}): SandboxToolPolicyResolved {
  const sessionAllow = params.sessionPolicy?.allow;
  const sessionDeny = params.sessionPolicy?.deny;
  const globalAllow = params.globalPolicy?.allow;
  const globalDeny = params.globalPolicy?.deny;

  const allowSource: SandboxToolPolicySource = Array.isArray(sessionAllow)
    ? { source: "session", key: "sessions[].sandbox.tools.allow" }
    : Array.isArray(globalAllow)
      ? { source: "global", key: "sandbox.tools.allow" }
      : { source: "default", key: "sandbox.tools.allow" };

  const denySource: SandboxToolPolicySource = Array.isArray(sessionDeny)
    ? { source: "session", key: "sessions[].sandbox.tools.deny" }
    : Array.isArray(globalDeny)
      ? { source: "global", key: "sandbox.tools.deny" }
      : { source: "default", key: "sandbox.tools.deny" };

  const deny = Array.isArray(sessionDeny)
    ? sessionDeny
    : Array.isArray(globalDeny)
      ? globalDeny
      : [...DEFAULT_TOOL_DENY];

  const allow = Array.isArray(sessionAllow)
    ? sessionAllow
    : Array.isArray(globalAllow)
      ? globalAllow
      : [...DEFAULT_TOOL_ALLOW];

  return {
    allow,
    deny,
    sources: {
      allow: allowSource,
      deny: denySource,
    },
  };
}

/**
 * Filter a list of tools by sandbox policy.
 */
export function filterToolsByPolicy(
  tools: string[],
  policy: SandboxToolPolicy
): { allowed: string[]; denied: string[] } {
  const allowed: string[] = [];
  const denied: string[] = [];

  for (const tool of tools) {
    if (isToolAllowed(policy, tool)) {
      allowed.push(tool);
    } else {
      denied.push(tool);
    }
  }

  return { allowed, denied };
}
