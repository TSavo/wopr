/**
 * WOPR Sandbox Constants
 * Copied from OpenClaw with WOPR paths.
 */

import { homedir } from "os";
import { join } from "path";
import { WOPR_HOME } from "../paths.js";

export const DEFAULT_SANDBOX_WORKSPACE_ROOT = join(homedir(), ".wopr", "sandboxes");

export const DEFAULT_SANDBOX_IMAGE = "wopr-sandbox:bookworm-slim";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "wopr-sbx-";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_IDLE_HOURS = 24;
export const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;

// Default tools allowed in sandbox
export const DEFAULT_TOOL_ALLOW = [
  "exec_command",
  "read",
  "write",
  "edit",
  "memory_read",
  "memory_write",
  "memory_search",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
] as const;

// Default tools denied in sandbox
export const DEFAULT_TOOL_DENY = [
  "http_fetch",      // No network in sandbox by default
  "cron_schedule",   // Can't create crons
  "cron_once",
  "config_set",      // Can't modify config
] as const;

export const SANDBOX_STATE_DIR = join(WOPR_HOME, "sandbox");
export const SANDBOX_REGISTRY_PATH = join(SANDBOX_STATE_DIR, "containers.json");
