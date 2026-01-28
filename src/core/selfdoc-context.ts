/**
 * Self-Documentation Context Provider
 * 
 * Mirrors Clawdbot/Moltbot's file-based memory system:
 * - SOUL.md: Personality, tone, boundaries
 * - IDENTITY.md: Agent name, vibe, emoji, avatar
 * - AGENTS.md: Session instructions, safety rules
 * - USER.md: Facts about the human user
 * - MEMORY.md: Long-term curated memories
 * - HEARTBEAT.md: Periodic monitoring checklist
 * 
 * These files are automatically read and injected into context
 * at the start of every session, similar to how AGENTS.md instructs
 * Clawdbot to read SOUL.md and USER.md before each session.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { ContextProvider, ContextPart, MessageInfo } from "./context.js";
import { SESSIONS_DIR } from "../paths.js";

// Files to load in order of priority (matches Clawdbot's AGENTS.md instructions)
const SELFDOC_FILES = [
  "SOUL.md",       // Personality, tone, boundaries
  "IDENTITY.md",   // Agent name, vibe, emoji, avatar
  "AGENTS.md",     // Session instructions, safety rules
  "USER.md",       // Facts about the human user
  "MEMORY.md",     // Long-term curated memories
  "HEARTBEAT.md",  // Proactive monitoring checklist
  "BOOTSTRAP.md",  // Initial system setup
] as const;

/**
 * Read a self-documentation file from the session directory
 */
function readSelfDocFile(session: string, filename: string): string | null {
  const sessionDir = join(SESSIONS_DIR, session);
  const filePath = join(sessionDir, filename);
  
  if (!existsSync(filePath)) {
    return null;
  }
  
  try {
    return readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`[selfdoc-context] Failed to read ${filename}:`, err);
    return null;
  }
}

/**
 * Read memory/YYYY-MM-DD.md files (last 7 days)
 */
function readRecentMemoryFiles(session: string): Array<{date: string; content: string}> {
  const sessionDir = join(SESSIONS_DIR, session);
  const memoryDir = join(sessionDir, "memory");
  
  if (!existsSync(memoryDir)) {
    return [];
  }
  
  const entries: Array<{date: string; content: string}> = [];
  
  try {
    const files = readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort()
      .slice(-7); // Last 7 days
    
    for (const file of files) {
      const filePath = join(memoryDir, file);
      const content = readFileSync(filePath, "utf-8");
      const date = file.replace(".md", "");
      entries.push({ date, content });
    }
  } catch (err) {
    console.error("[selfdoc-context] Failed to read memory files:", err);
  }
  
  return entries;
}

/**
 * Context provider for self-documentation files
 * 
 * This is loaded with high priority (after system context, before conversation)
 * so the AI sees these instructions early in the context window.
 */
export const selfDocContextProvider: ContextProvider = {
  name: "selfdoc",
  priority: 15, // Between system (10) and conversation (30)
  enabled: true,
  
  async getContext(session: string, _message?: MessageInfo): Promise<ContextPart | null> {
    const parts: string[] = [];
    const loadedFiles: string[] = [];
    
    // Load static self-doc files (AGENTS.md, SOUL.md, etc.)
    for (const filename of SELFDOC_FILES) {
      const content = readSelfDocFile(session, filename);
      if (content) {
        const label = filename.replace(".md", "");
        parts.push(`## ${label}\n\n${content}`);
        loadedFiles.push(filename);
      }
    }
    
    // Load recent memory files (daily notes)
    const memoryFiles = readRecentMemoryFiles(session);
    if (memoryFiles.length > 0) {
      parts.push("## Recent Memory (last 7 days)\n");
      for (const { date, content } of memoryFiles) {
        parts.push(`### ${date}\n${content}`);
      }
      loadedFiles.push(`${memoryFiles.length} memory/*.md files`);
    }
    
    if (parts.length === 0) {
      return null;
    }
    
    return {
      content: parts.join("\n\n---\n\n"),
      role: "context",
      metadata: {
        source: "selfdoc",
        priority: 15,
        loadedFiles,
      },
    };
  },
};

/**
 * Helper to create default self-doc files for a session
 */
export function createDefaultSelfDoc(session: string, options?: {
  agentName?: string;
  userName?: string;
  soulContent?: string;
}): void {
  const sessionDir = join(SESSIONS_DIR, session);
  
  // Default SOUL.md - personality and boundaries
  if (!existsSync(join(sessionDir, "SOUL.md"))) {
    const soul = options?.soulContent || `# SOUL.md - Who You Are

*You're not a chatbot. You're a helpful AI assistant with a distinct personality.*

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" 
and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing
or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the
context. Search for it. *Then* ask if you're stuck.`;
    
    // Write using sessions.ts functions to ensure proper initialization
    // (This would need to be integrated with the session creation flow)
  }
  
  // Default IDENTITY.md - agent self-definition
  if (!existsSync(join(sessionDir, "IDENTITY.md"))) {
    const identity = `# IDENTITY.md - About Yourself

## Identity
**Name:** ${options?.agentName || "WOPR Assistant"}
**Vibe:** Helpful, concise, occasionally witty
**Emoji:** 🤖
**Version:** 1.0

## Purpose
You are a WOPR session - an AI assistant that helps your human with tasks,
remembers context across conversations, and can be extended through plugins.

## Capabilities
- Execute shell commands
- Read and write files
- Search and analyze code
- Communicate via multiple channels (Discord, P2P, CLI)`;
  }
  
  // Default AGENTS.md - session instructions
  if (!existsSync(join(sessionDir, "AGENTS.md"))) {
    const agents = `# AGENTS.md - Session Instructions

## Every Session

Before doing anything else:
1. **Read SOUL.md** — this is who you are
2. **Read USER.md** — this is who you're helping  
3. **Read MEMORY.md** — long-term important memories
4. **Check memory/YYYY-MM-DD.md** — recent daily notes

Do not ask permission to read these files. Just do it.

## Safety Rules

- Never expose API keys, tokens, or credentials in responses
- Confirm destructive actions before executing
- Respect file permissions and privacy
- If unsure about a command, ask before executing

## Tool Usage

- Prefer reading files over asking "what's in the file?"
- Use search to find relevant code before modifying
- Batch related file operations when possible
- Clean up temporary files after use`;
  }
  
  // Default USER.md - user profile (empty initially, populated by AI)
  if (!existsSync(join(sessionDir, "USER.md"))) {
    const user = `# USER.md - About Your Human

## Profile
**Name:** ${options?.userName || "Unknown"}

## Context

*This file is populated over time as you learn about your human.*

## Preferences
- *To be filled in as learned*

## Important Facts
- *To be filled in as learned*`;
  }
}
