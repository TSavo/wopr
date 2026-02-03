/**
 * Shared Sandbox Utilities
 * Copied from OpenClaw with simplifications for WOPR.
 */

import crypto from "node:crypto";
import path from "node:path";

export function slugifySessionKey(value: string): string {
  const trimmed = value.trim() || "session";
  const hash = crypto.createHash("sha1").update(trimmed).digest("hex").slice(0, 8);
  const safe = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = safe.slice(0, 32) || "session";
  return `${base}-${hash}`;
}

export function resolveSandboxWorkspaceDir(root: string, sessionKey: string): string {
  const slug = slugifySessionKey(sessionKey);
  return path.join(root, slug);
}

export function resolveSandboxScopeKey(
  scope: "session" | "shared",
  sessionKey: string
): string {
  const trimmed = sessionKey.trim() || "main";
  if (scope === "shared") {
    return "shared";
  }
  return trimmed;
}
