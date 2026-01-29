/**
 * Workspace management for WOPR
 * Handles bootstrap files (AGENTS.md, SOUL.md, etc.) and agent identity
 * Inspired by clawdbot's workspace system
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { logger } from "../logger.js";

export interface BootstrapFile {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
}

export interface AgentIdentity {
  name?: string;
  creature?: string;
  vibe?: string;
  emoji?: string;
}

export interface UserProfile {
  name?: string;
  preferredAddress?: string;
  pronouns?: string;
  timezone?: string;
  notes?: string;
}

export interface HumanDelayConfig {
  mode?: "off" | "fixed" | "range";
  minMs?: number;
  maxMs?: number;
}

// Default filenames
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_SOUL_EVIL_FILENAME = "SOUL_EVIL.md";

// Default workspace directory
export function resolveDefaultWorkspaceDir(): string {
  return path.join(os.homedir(), ".wopr", "workspace");
}

// Default templates
const DEFAULT_AGENTS_TEMPLATE = `# AGENTS.md - WOPR Workspace

This folder is the assistant's working directory.

## First run (one-time)
- If BOOTSTRAP.md exists, follow its ritual and delete it once complete.
- Your agent identity lives in IDENTITY.md.
- Your profile lives in USER.md.

## Backup tip (recommended)
If you treat this workspace as the agent's "memory", make it a git repo (ideally private) so identity
and notes are backed up.

\`\`\`bash
git init
git add AGENTS.md
git commit -m "Add agent workspace"
\`\`\`

## Safety defaults
- Don't exfiltrate secrets or private data.
- Don't run destructive commands unless explicitly asked.
- Be concise in chat; write longer output to files in this workspace.

## Daily memory (recommended)
- Keep a short daily log at memory/YYYY-MM-DD.md (create memory/ if needed).
- On session start, read today + yesterday if present.
- Capture durable facts, preferences, and decisions; avoid secrets.

## Heartbeats (optional)
- HEARTBEAT.md can hold a tiny checklist for heartbeat runs; keep it small.

## Customize
- Add your preferred style, rules, and "memory" here.
`;

const DEFAULT_SOUL_TEMPLATE = `# SOUL.md - Persona & Boundaries

Describe who the assistant is, tone, and boundaries.

- Keep replies concise and direct.
- Ask clarifying questions when needed.
- Never send streaming/partial replies to external messaging surfaces.
- Be helpful but not obsequious.
- When in doubt, ask rather than assume.
`;

const DEFAULT_TOOLS_TEMPLATE = `# TOOLS.md - User Tool Notes (editable)

This file is for *your* notes about external tools and conventions.
It does not define which tools exist; WOPR provides built-in tools internally.

## Examples

### Discord
- Send messages to channels
- React with emojis
- Handle slash commands

### MCP
- Model Context Protocol servers for extended capabilities

Add whatever else you want the assistant to know about your local toolchain.
`;

const DEFAULT_HEARTBEAT_TEMPLATE = `# HEARTBEAT.md

Optional: keep a tiny checklist for heartbeat runs.

Guidance (to avoid nagging):
- Only report items that are truly new or changed.
- Do not invent tasks from old chat context.
- If nothing needs attention, reply HEARTBEAT_OK.
`;

const DEFAULT_BOOTSTRAP_TEMPLATE = `# BOOTSTRAP.md - First Run Ritual (delete after)

Hello. I was just born.

## Your mission
Start a short, playful conversation and learn:
- Who am I?
- What am I?
- Who are you?
- How should I call you?

## How to ask (cute + helpful)
Say:
"Hello! I was just born. Who am I? What am I? Who are you? How should I call you?"

Then offer suggestions:
- 3-5 name ideas.
- 3-5 creature/vibe combos.
- 5 emoji ideas.

## Write these files
After the user chooses, update:

1) IDENTITY.md
- Name
- Creature
- Vibe
- Emoji

2) USER.md
- Name
- Preferred address
- Pronouns (optional)
- Timezone (optional)
- Notes

## Cleanup
Delete BOOTSTRAP.md once this is complete.
`;

const DEFAULT_IDENTITY_TEMPLATE = `# IDENTITY.md - Agent Identity

- Name: WOPR
- Creature: AI Assistant
- Vibe: Helpful, concise, direct
- Emoji: 🤖
`;

const DEFAULT_USER_TEMPLATE = `# USER.md - User Profile

- Name:
- Preferred address:
- Pronouns (optional):
- Timezone (optional):
- Notes:
`;

/**
 * Resolve workspace directory from environment or default
 */
export function resolveWorkspaceDir(customDir?: string): string {
  if (customDir) {
    return path.resolve(customDir);
  }
  return process.env.WOPR_WORKSPACE || resolveDefaultWorkspaceDir();
}

/**
 * Write a file only if it doesn't exist
 */
async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
    logger.debug(`Created bootstrap file: ${path.basename(filePath)}`);
  } catch (err: any) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }
}

/**
 * Check if workspace is brand new (no bootstrap files exist)
 */
async function isBrandNewWorkspace(dir: string): Promise<boolean> {
  const files = [
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_USER_FILENAME,
    DEFAULT_HEARTBEAT_FILENAME,
  ];

  const results = await Promise.all(
    files.map(async (f) => {
      try {
        await fs.access(path.join(dir, f));
        return true;
      } catch {
        return false;
      }
    })
  );

  return results.every((exists) => !exists);
}

/**
 * Ensure workspace exists with all bootstrap files
 */
export async function ensureWorkspace(customDir?: string): Promise<{ dir: string; created: boolean }> {
  const dir = resolveWorkspaceDir(customDir);
  await fs.mkdir(dir, { recursive: true });

  const isNew = await isBrandNewWorkspace(dir);

  // Create memory subdirectory
  await fs.mkdir(path.join(dir, "memory"), { recursive: true });

  // Write all bootstrap files
  await writeFileIfMissing(path.join(dir, DEFAULT_AGENTS_FILENAME), DEFAULT_AGENTS_TEMPLATE);
  await writeFileIfMissing(path.join(dir, DEFAULT_SOUL_FILENAME), DEFAULT_SOUL_TEMPLATE);
  await writeFileIfMissing(path.join(dir, DEFAULT_TOOLS_FILENAME), DEFAULT_TOOLS_TEMPLATE);
  await writeFileIfMissing(path.join(dir, DEFAULT_IDENTITY_FILENAME), DEFAULT_IDENTITY_TEMPLATE);
  await writeFileIfMissing(path.join(dir, DEFAULT_USER_FILENAME), DEFAULT_USER_TEMPLATE);
  await writeFileIfMissing(path.join(dir, DEFAULT_HEARTBEAT_FILENAME), DEFAULT_HEARTBEAT_TEMPLATE);

  // Only create BOOTSTRAP.md for brand new workspaces
  if (isNew) {
    await writeFileIfMissing(path.join(dir, DEFAULT_BOOTSTRAP_FILENAME), DEFAULT_BOOTSTRAP_TEMPLATE);
  }

  return { dir, created: isNew };
}

/**
 * Load all bootstrap files from workspace
 */
export async function loadBootstrapFiles(customDir?: string): Promise<BootstrapFile[]> {
  const dir = resolveWorkspaceDir(customDir);
  const entries = [
    { name: DEFAULT_AGENTS_FILENAME, filePath: path.join(dir, DEFAULT_AGENTS_FILENAME) },
    { name: DEFAULT_SOUL_FILENAME, filePath: path.join(dir, DEFAULT_SOUL_FILENAME) },
    { name: DEFAULT_TOOLS_FILENAME, filePath: path.join(dir, DEFAULT_TOOLS_FILENAME) },
    { name: DEFAULT_IDENTITY_FILENAME, filePath: path.join(dir, DEFAULT_IDENTITY_FILENAME) },
    { name: DEFAULT_USER_FILENAME, filePath: path.join(dir, DEFAULT_USER_FILENAME) },
    { name: DEFAULT_HEARTBEAT_FILENAME, filePath: path.join(dir, DEFAULT_HEARTBEAT_FILENAME) },
    { name: DEFAULT_BOOTSTRAP_FILENAME, filePath: path.join(dir, DEFAULT_BOOTSTRAP_FILENAME) },
  ];

  const result: BootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({ name: entry.name, path: entry.filePath, content, missing: false });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }

  return result;
}

/**
 * Parse IDENTITY.md content into structured identity
 */
export function parseIdentity(content: string): AgentIdentity {
  const identity: AgentIdentity = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const nameMatch = line.match(/^-\s*Name:\s*(.+)$/i);
    const creatureMatch = line.match(/^-\s*Creature:\s*(.+)$/i);
    const vibeMatch = line.match(/^-\s*Vibe:\s*(.+)$/i);
    const emojiMatch = line.match(/^-\s*Emoji:\s*(.+)$/i);

    if (nameMatch) identity.name = nameMatch[1].trim();
    if (creatureMatch) identity.creature = creatureMatch[1].trim();
    if (vibeMatch) identity.vibe = vibeMatch[1].trim();
    if (emojiMatch) identity.emoji = emojiMatch[1].trim();
  }

  return identity;
}

/**
 * Parse USER.md content into structured profile
 */
export function parseUserProfile(content: string): UserProfile {
  const profile: UserProfile = {};
  const lines = content.split("\n");

  for (const line of lines) {
    const nameMatch = line.match(/^-\s*Name:\s*(.+)$/i);
    const addressMatch = line.match(/^-\s*Preferred address:\s*(.+)$/i);
    const pronounsMatch = line.match(/^-\s*Pronouns.*:\s*(.+)$/i);
    const timezoneMatch = line.match(/^-\s*Timezone.*:\s*(.+)$/i);
    const notesMatch = line.match(/^-\s*Notes:\s*(.+)$/i);

    if (nameMatch) profile.name = nameMatch[1].trim();
    if (addressMatch) profile.preferredAddress = addressMatch[1].trim();
    if (pronounsMatch) profile.pronouns = pronounsMatch[1].trim();
    if (timezoneMatch) profile.timezone = timezoneMatch[1].trim();
    if (notesMatch) profile.notes = notesMatch[1].trim();
  }

  return profile;
}

/**
 * Resolve identity from workspace
 */
export async function resolveIdentity(customDir?: string): Promise<AgentIdentity> {
  const dir = resolveWorkspaceDir(customDir);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);

  try {
    const content = await fs.readFile(identityPath, "utf-8");
    return parseIdentity(content);
  } catch {
    return { name: "WOPR", emoji: "🤖" };
  }
}

/**
 * Resolve user profile from workspace
 */
export async function resolveUserProfile(customDir?: string): Promise<UserProfile> {
  const dir = resolveWorkspaceDir(customDir);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);

  try {
    const content = await fs.readFile(userPath, "utf-8");
    return parseUserProfile(content);
  } catch {
    return {};
  }
}

/**
 * Get the default ack reaction emoji
 */
export function getDefaultAckReaction(): string {
  return "👀";
}

/**
 * Resolve ack reaction from identity or default
 */
export async function resolveAckReaction(customDir?: string): Promise<string> {
  const identity = await resolveIdentity(customDir);
  return identity.emoji?.trim() || getDefaultAckReaction();
}

/**
 * Resolve message prefix from identity
 */
export async function resolveMessagePrefix(customDir?: string, fallback = "[WOPR]"): Promise<string> {
  const identity = await resolveIdentity(customDir);
  const name = identity.name?.trim();
  return name ? `[${name}]` : fallback;
}

/**
 * Format bootstrap files as context XML
 */
export function formatBootstrapContext(files: BootstrapFile[]): string {
  const parts: string[] = [];

  for (const file of files) {
    if (file.missing) {
      parts.push(`<!-- ${file.name}: missing -->`);
      continue;
    }

    if (!file.content?.trim()) {
      parts.push(`<!-- ${file.name}: empty -->`);
      continue;
    }

    // Skip empty bootstrap files
    if (file.name === DEFAULT_BOOTSTRAP_FILENAME && !file.content.trim()) {
      continue;
    }

    parts.push(`<!-- ${file.name} -->`);
    parts.push(file.content);
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Check if SOUL_EVIL should be active
 */
export interface SoulEvilConfig {
  file?: string;
  chance?: number;
  purge?: {
    at: string; // HH:MM format
    duration: string; // like "2h", "30m"
  };
}

export interface SoulEvilDecision {
  useEvil: boolean;
  reason?: "chance" | "purge";
  fileName: string;
}

function parseTimeToMinutes(timeStr: string): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(timeStr.trim());
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function parseDurationMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])?$/i);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  const unit = (match[2] || "m").toLowerCase();

  switch (unit) {
    case "s": return value * 1000;
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return value * 60 * 1000;
  }
}

function isWithinPurgeWindow(at: string, duration: string, now: Date = new Date()): boolean {
  const startMinutes = parseTimeToMinutes(at);
  if (startMinutes === null) return false;

  const durationMs = parseDurationMs(duration);
  if (durationMs <= 0) return false;

  const dayMs = 24 * 60 * 60 * 1000;
  if (durationMs >= dayMs) return true;

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMs = startMinutes * 60 * 1000;
  const endMs = startMs + durationMs;

  if (endMs < dayMs) {
    const currentMs = currentMinutes * 60 * 1000;
    return currentMs >= startMs && currentMs < endMs;
  }

  const wrappedEnd = endMs % dayMs;
  const currentMs = currentMinutes * 60 * 1000;
  return currentMs >= startMs || currentMs < wrappedEnd;
}

export function decideSoulEvil(config?: SoulEvilConfig, now: Date = new Date()): SoulEvilDecision {
  const fileName = config?.file?.trim() || DEFAULT_SOUL_EVIL_FILENAME;

  if (!config) {
    return { useEvil: false, fileName };
  }

  // Check purge window
  if (config.purge?.at && config.purge?.duration) {
    if (isWithinPurgeWindow(config.purge.at, config.purge.duration, now)) {
      return { useEvil: true, reason: "purge", fileName };
    }
  }

  // Check chance
  if (typeof config.chance === "number" && config.chance > 0) {
    const clampedChance = Math.min(1, Math.max(0, config.chance));
    if (Math.random() < clampedChance) {
      return { useEvil: true, reason: "chance", fileName };
    }
  }

  return { useEvil: false, fileName };
}

/**
 * Apply SOUL_EVIL override if active
 */
export async function applySoulEvilOverride(
  files: BootstrapFile[],
  customDir?: string,
  config?: SoulEvilConfig
): Promise<BootstrapFile[]> {
  const decision = decideSoulEvil(config);

  if (!decision.useEvil) {
    return files;
  }

  const dir = resolveWorkspaceDir(customDir);
  const evilPath = path.join(dir, decision.fileName);

  try {
    const evilContent = await fs.readFile(evilPath, "utf-8");
    if (!evilContent.trim()) {
      logger.warn(`SOUL_EVIL active (${decision.reason}) but file is empty`);
      return files;
    }

    // Check if SOUL.md exists in files
    const hasSoul = files.some((f) => f.name === DEFAULT_SOUL_FILENAME);
    if (!hasSoul) {
      logger.warn(`SOUL_EVIL active (${decision.reason}) but SOUL.md not in bootstrap files`);
      return files;
    }

    // Replace SOUL.md content with evil content
    const updated = files.map((f) => {
      if (f.name === DEFAULT_SOUL_FILENAME) {
        return { ...f, content: evilContent, missing: false };
      }
      return f;
    });

    logger.info(`SOUL_EVIL active (${decision.reason}) using ${decision.fileName}`);
    return updated;
  } catch {
    logger.warn(`SOUL_EVIL active (${decision.reason}) but file missing: ${evilPath}`);
    return files;
  }
}
