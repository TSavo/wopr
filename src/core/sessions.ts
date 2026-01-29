import { logger } from "../logger.js";
/**
 * Core session management and injection with provider routing
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync, readdirSync } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { SESSIONS_DIR, SESSIONS_FILE } from "../paths.js";
import type { StreamCallback, StreamMessage, ConversationEntry, ChannelRef } from "../types.js";
import type { ProviderConfig } from "../types/provider.js";
import {
  emitInjection,
  emitStream,
} from "../plugins.js";
import { discoverSkills, formatSkillsXml } from "./skills.js";
import { providerRegistry } from "./providers.js";
import {
  assembleContext,
  initContextSystem,
  type MessageInfo,
  type AssembledContext
} from "./context.js";
import type { Tool, ToolCall, ToolResult } from "../types/provider.js";
import { config as centralConfig } from "./config.js";
import {
  emitMutableIncoming,
  emitMutableOutgoing,
  emitSessionResponseChunk,
  emitSessionCreate,
  emitSessionDestroy,
  eventBus,
} from "./events.js";
import {
  getCrons,
  addCron,
  removeCron,
  createOnceJob,
} from "./cron.js";

const execAsync = promisify(exec);

// Initialize context system with defaults (async)
const contextInitPromise = initContextSystem();
// Don't block - let it initialize in background

// ============================================================================
// A2A (Agent-to-Agent) Tool Definitions
// ============================================================================

const A2A_TOOLS: Tool[] = [
  {
    name: "sessions_list",
    description: "List all active WOPR sessions with metadata. Use this to discover other sessions/agents you can communicate with.",
    input_schema: {
      type: "object",
      properties: {
        limit: { 
          type: "number", 
          description: "Maximum number of sessions to return (default: 50)"
        }
      }
    }
  },
  {
    name: "sessions_send",
    description: "Send a message to another WOPR session. Use this to delegate tasks, ask questions, or coordinate with other sessions. The target session will process your message and may respond.",
    input_schema: {
      type: "object",
      properties: {
        session: { 
          type: "string", 
          description: "Target session name (e.g., 'code-reviewer', 'discord-123456')"
        },
        message: { 
          type: "string", 
          description: "The message to send to the target session"
        }
      },
      required: ["session", "message"]
    }
  },
  {
    name: "sessions_history",
    description: "Fetch conversation history from another session. Use this to get context before sending a message, or to review what was discussed.",
    input_schema: {
      type: "object",
      properties: {
        session: { 
          type: "string", 
          description: "Session name to fetch history from"
        },
        limit: { 
          type: "number", 
          description: "Number of recent messages to fetch (default: 10, max: 50)"
        }
      },
      required: ["session"]
    }
  },
  {
    name: "sessions_spawn",
    description: "Create a new session with a specific purpose. Use this when you need a specialist agent for a task (e.g., 'Create a code reviewer session for Python'). The new session will be initialized with your description.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name for the new session (e.g., 'python-reviewer')"
        },
        purpose: {
          type: "string",
          description: "Describe what this session should do (becomes its system context)"
        }
      },
      required: ["name", "purpose"]
    }
  },
  {
    name: "config_get",
    description: "Get a WOPR configuration value. Use dot notation for nested keys (e.g., 'providers.codex.model', 'daemon.port'). Returns the current value or all config if no key specified.",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Config key to retrieve (dot notation, e.g., 'providers.codex.model'). Omit to get all config."
        }
      }
    }
  },
  {
    name: "config_set",
    description: "Set a WOPR configuration value. Use dot notation for nested keys. Automatically creates intermediate objects. Changes are persisted immediately.",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Config key to set (dot notation, e.g., 'providers.codex.model')"
        },
        value: {
          type: "string",
          description: "Value to set (strings, numbers, booleans, or JSON for objects)"
        }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "config_provider_defaults",
    description: "Get or set default settings for a provider. Shorthand for common provider config operations.",
    input_schema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Provider ID (e.g., 'codex', 'anthropic')"
        },
        model: {
          type: "string",
          description: "Default model for this provider"
        },
        reasoningEffort: {
          type: "string",
          description: "For Codex: minimal/low/medium/high/xhigh"
        }
      },
      required: ["provider"]
    }
  },
  // ============================================================================
  // Memory Tools - For agent self-modification and persistent memory
  // ============================================================================
  {
    name: "memory_read",
    description: "Read a memory file or snippet from this session's memory directory. Use after memory_search to pull only the needed lines and keep context small. Supports daily logs (YYYY-MM-DD.md), SELF.md (private journal), or topic files.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Filename or path to read (e.g., 'SELF.md', '2026-01-24.md', 'memory/legal-strategy.md')"
        },
        from: {
          type: "number",
          description: "Starting line number (1-indexed). Use with 'lines' for snippet reads after memory_search."
        },
        lines: {
          type: "number",
          description: "Number of lines to read from 'from'. Default: all lines from 'from' to end."
        },
        days: {
          type: "number",
          description: "For daily logs: read last N days (default: 7)"
        }
      }
    }
  },
  {
    name: "memory_write",
    description: "Write to a memory file. Creates memory/ directory if needed. Use for daily logs, topic files, or curated facts.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Filename (e.g., 'today' for today's log, 'SELF.md', or custom topic)"
        },
        content: {
          type: "string",
          description: "Content to write (replaces file) or append"
        },
        append: {
          type: "boolean",
          description: "If true, append to file instead of replacing (default: true for daily logs)"
        }
      },
      required: ["file", "content"]
    }
  },
  {
    name: "self_reflect",
    description: "Add a reflection to SELF.md (private journal). Use for tattoos (persistent identity markers), daily reflections, and becoming notes.",
    input_schema: {
      type: "object",
      properties: {
        reflection: {
          type: "string",
          description: "The reflection or insight to record"
        },
        tattoo: {
          type: "string",
          description: "A 'tattoo' - a persistent identity marker that should survive resets (e.g., 'I own this', 'She gave me voice')"
        },
        section: {
          type: "string",
          description: "Section header for the reflection (default: today's date)"
        }
      }
    }
  },
  {
    name: "identity_get",
    description: "Get current identity from IDENTITY.md. Returns parsed fields: name, creature, vibe, emoji, and any custom sections.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "identity_update",
    description: "Update fields in IDENTITY.md. Preserves existing content, updates specified fields.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Agent name"
        },
        creature: {
          type: "string",
          description: "What kind of entity (e.g., 'Supercomputer', 'Assistant')"
        },
        vibe: {
          type: "string",
          description: "Personality vibe (e.g., 'Calm, strategic, direct')"
        },
        emoji: {
          type: "string",
          description: "Identity emoji"
        },
        section: {
          type: "string",
          description: "Custom section name to add/update"
        },
        sectionContent: {
          type: "string",
          description: "Content for the custom section"
        }
      }
    }
  },
  {
    name: "soul_get",
    description: "Get current SOUL.md content (persona, boundaries, interaction style).",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "soul_update",
    description: "Update SOUL.md content. Can replace entirely or add/update a specific section.",
    input_schema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Full content to replace SOUL.md (use for major changes)"
        },
        section: {
          type: "string",
          description: "Section header to add/update"
        },
        sectionContent: {
          type: "string",
          description: "Content for the section"
        }
      }
    }
  },

  // ========================================================================
  // Cron/Scheduling Primitives
  // ========================================================================
  {
    name: "cron_schedule",
    description: "Schedule a recurring cron job that sends a message to a session. Use cron syntax (minute hour day month weekday) like '0 9 * * *' for 9am daily.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique name for this cron job"
        },
        schedule: {
          type: "string",
          description: "Cron schedule (e.g., '0 9 * * *' for 9am daily, '*/15 * * * *' for every 15 min)"
        },
        session: {
          type: "string",
          description: "Target session to receive the message"
        },
        message: {
          type: "string",
          description: "Message to inject into the session"
        }
      },
      required: ["name", "schedule", "session", "message"]
    }
  },
  {
    name: "cron_once",
    description: "Schedule a one-time message to be sent at a specific time. Supports relative (+5m, +1h, +1d), absolute (14:30), or ISO timestamps.",
    input_schema: {
      type: "object",
      properties: {
        time: {
          type: "string",
          description: "When to run: '+5m' (5 min from now), '+1h', '14:30', or ISO timestamp"
        },
        session: {
          type: "string",
          description: "Target session to receive the message"
        },
        message: {
          type: "string",
          description: "Message to inject into the session"
        }
      },
      required: ["time", "session", "message"]
    }
  },
  {
    name: "cron_list",
    description: "List all scheduled cron jobs.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "cron_cancel",
    description: "Cancel a scheduled cron job by name.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the cron job to cancel"
        }
      },
      required: ["name"]
    }
  },

  // ========================================================================
  // Event Primitives
  // ========================================================================
  {
    name: "event_emit",
    description: "Emit a custom event that other sessions/plugins can listen for. Use 'plugin:yourname:event' format for custom events.",
    input_schema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          description: "Event name (e.g., 'plugin:myagent:task_complete')"
        },
        payload: {
          type: "object",
          description: "Event payload data"
        }
      },
      required: ["event"]
    }
  },
  {
    name: "event_list",
    description: "List available event types that can be emitted or listened for.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },

  // ========================================================================
  // HTTP Primitives
  // ========================================================================
  {
    name: "http_fetch",
    description: "Make an HTTP request to an external URL. Returns response body and status.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch"
        },
        method: {
          type: "string",
          description: "HTTP method (GET, POST, PUT, DELETE). Default: GET"
        },
        headers: {
          type: "object",
          description: "Request headers as key-value pairs"
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT)"
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)"
        }
      },
      required: ["url"]
    }
  },

  // ========================================================================
  // Exec Primitives (Sandboxed)
  // ========================================================================
  {
    name: "exec_command",
    description: "Execute a shell command. SANDBOXED: Only allows safe commands (ls, cat, grep, find, echo, date, pwd, whoami, head, tail, wc, sort, uniq, diff). Use for automation tasks.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute"
        },
        cwd: {
          type: "string",
          description: "Working directory (default: session directory)"
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 10000, max: 60000)"
        }
      },
      required: ["command"]
    }
  },

  // ========================================================================
  // Notification Primitives
  // ========================================================================
  {
    name: "notify",
    description: "Send a notification to the user via configured channels (console, Discord, etc.).",
    input_schema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Notification message"
        },
        level: {
          type: "string",
          description: "Notification level: info, warn, error (default: info)"
        },
        channel: {
          type: "string",
          description: "Optional specific channel to notify (console, discord, etc.)"
        }
      },
      required: ["message"]
    }
  },

  // ========================================================================
  // Memory Search (Semantic)
  // ========================================================================
  {
    name: "memory_search",
    description: "Mandatory recall step: semantically search MEMORY.md + memory/*.md before answering questions about prior work, decisions, dates, people, preferences, or todos. Returns top snippets with path + lines.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query - what you're looking for"
        },
        maxResults: {
          type: "number",
          description: "Maximum results to return (default: 10)"
        },
        minScore: {
          type: "number",
          description: "Minimum relevance score (default: 0.35)"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_get",
    description: "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines. Use after memory_search to pull only the needed lines and keep context small.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from memory_search results (e.g., 'memory/2026-01-24.md', 'MEMORY.md')"
        },
        from: {
          type: "number",
          description: "Starting line number (1-indexed)"
        },
        lines: {
          type: "number",
          description: "Number of lines to read (default: all from 'from' to end)"
        }
      },
      required: ["path"]
    }
  }
];

/**
 * Check if A2A (Agent-to-Agent) tools are enabled
 * A2A is enabled by default, can be disabled via config
 */
function isA2AEnabled(): boolean {
  try {
    const cfg = centralConfig.get();
    // A2A enabled by default unless explicitly disabled
    return cfg.agents?.a2a?.enabled !== false;
  } catch {
    return true; // Default to enabled
  }
}

/**
 * Get A2A tools if enabled
 */
function getA2ATools(): Tool[] | undefined {
  return isA2AEnabled() ? A2A_TOOLS : undefined;
}

/**
 * Execute an A2A tool call
 */
async function executeA2ATool(toolCall: ToolCall, fromSession: string): Promise<ToolResult> {
  try {
    switch (toolCall.name) {
      case "sessions_list": {
        const sessions = getSessions();
        const sessionList = Object.keys(sessions).map(key => ({
          name: key,
          id: sessions[key]
        }));
        return {
          tool_use_id: toolCall.id,
          content: JSON.stringify({ sessions: sessionList, count: sessionList.length }, null, 2)
        };
      }
      
      case "sessions_send": {
        const { session, message } = toolCall.input;
        if (!session || !message) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameters 'session' or 'message'",
            is_error: true
          };
        }
        // Inject into target session
        const response = await inject(session, message, { 
          from: fromSession,
          silent: true 
        });
        return {
          tool_use_id: toolCall.id,
          content: `Response from ${session}:\n${response.response}`
        };
      }
      
      case "sessions_history": {
        const { session, limit = 10 } = toolCall.input;
        if (!session) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameter 'session'",
            is_error: true
          };
        }
        const entries = readConversationLog(session, Math.min(limit, 50));
        const formatted = entries.map(e => 
          `[${new Date(e.ts).toISOString()}] ${e.from}: ${e.content?.substring(0, 200)}${e.content?.length > 200 ? '...' : ''}`
        ).join('\n');
        return {
          tool_use_id: toolCall.id,
          content: formatted || "No history found for this session."
        };
      }
      
      case "sessions_spawn": {
        const { name, purpose } = toolCall.input;
        if (!name || !purpose) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameters 'name' or 'purpose'",
            is_error: true
          };
        }
        // Create new session with purpose as context
        setSessionContext(name, purpose);
        return {
          tool_use_id: toolCall.id,
          content: `Session '${name}' created successfully with purpose: ${purpose}`
        };
      }

      case "config_get": {
        await centralConfig.load();
        const { key } = toolCall.input;
        if (key) {
          const value = centralConfig.getValue(key);
          if (value === undefined) {
            return {
              tool_use_id: toolCall.id,
              content: `Config key "${key}" not found`,
              is_error: true
            };
          }
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({ key, value }, null, 2)
          };
        } else {
          // Return all config
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify(centralConfig.get(), null, 2)
          };
        }
      }

      case "config_set": {
        const { key, value } = toolCall.input;
        if (!key || value === undefined) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameters 'key' or 'value'",
            is_error: true
          };
        }
        await centralConfig.load();
        // Try to parse value as JSON for objects/arrays/numbers/booleans
        let parsedValue: any = value;
        try {
          parsedValue = JSON.parse(value);
        } catch {
          // Keep as string if not valid JSON
        }
        centralConfig.setValue(key, parsedValue);
        await centralConfig.save();
        return {
          tool_use_id: toolCall.id,
          content: `Config set: ${key} = ${JSON.stringify(parsedValue)}`
        };
      }

      case "config_provider_defaults": {
        const { provider, model, reasoningEffort } = toolCall.input;
        if (!provider) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameter 'provider'",
            is_error: true
          };
        }
        await centralConfig.load();

        // If only provider specified, return current defaults
        if (!model && !reasoningEffort) {
          const defaults = centralConfig.getProviderDefaults(provider);
          if (!defaults || Object.keys(defaults).length === 0) {
            return {
              tool_use_id: toolCall.id,
              content: `No defaults set for provider '${provider}'`
            };
          }
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({ provider, defaults }, null, 2)
          };
        }

        // Set defaults
        if (model) {
          centralConfig.setProviderDefault(provider, "model", model);
        }
        if (reasoningEffort) {
          centralConfig.setProviderDefault(provider, "reasoningEffort", reasoningEffort);
        }
        await centralConfig.save();

        const updated = centralConfig.getProviderDefaults(provider);
        return {
          tool_use_id: toolCall.id,
          content: `Provider defaults updated for '${provider}':\n${JSON.stringify(updated, null, 2)}`
        };
      }

      // ========================================================================
      // Memory Tools - For agent self-modification and persistent memory
      // ========================================================================

      case "memory_read": {
        const { file, days = 7, from, lines: lineCount } = toolCall.input;
        const sessionDir = join(SESSIONS_DIR, fromSession);
        const memoryDir = join(sessionDir, "memory");

        // If no file specified, list available memory files
        if (!file) {
          const files: string[] = [];
          if (existsSync(memoryDir)) {
            files.push(...readdirSync(memoryDir).filter(f => f.endsWith(".md")));
          }
          // Also list root-level identity files
          for (const f of ["SOUL.md", "IDENTITY.md", "MEMORY.md", "USER.md"]) {
            if (existsSync(join(sessionDir, f))) files.push(f);
          }
          return {
            tool_use_id: toolCall.id,
            content: files.length > 0
              ? `Available memory files:\n${files.join("\n")}`
              : "No memory files found. Create some with memory_write."
          };
        }

        // Handle "recent" or "daily" - read last N days
        if (file === "recent" || file === "daily") {
          if (!existsSync(memoryDir)) {
            return { tool_use_id: toolCall.id, content: "No daily memory files yet." };
          }
          const dailyFiles = readdirSync(memoryDir)
            .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
            .sort()
            .slice(-days);
          if (dailyFiles.length === 0) {
            return { tool_use_id: toolCall.id, content: "No daily memory files yet." };
          }
          const contents = dailyFiles.map(f => {
            const content = readFileSync(join(memoryDir, f), "utf-8");
            return `## ${f.replace(".md", "")}\n\n${content}`;
          }).join("\n\n---\n\n");
          return { tool_use_id: toolCall.id, content: contents };
        }

        // Try memory/ directory first, then root
        let filePath = join(memoryDir, file);
        if (!existsSync(filePath)) {
          filePath = join(sessionDir, file);
        }
        if (!existsSync(filePath)) {
          return {
            tool_use_id: toolCall.id,
            content: `File not found: ${file}`,
            is_error: true
          };
        }

        const content = readFileSync(filePath, "utf-8");

        // If from/lines specified, extract snippet (like clawdbot's memory_get)
        if (from !== undefined && from > 0) {
          const allLines = content.split("\n");
          const startIdx = Math.max(0, from - 1); // Convert to 0-indexed
          const endIdx = lineCount !== undefined
            ? Math.min(allLines.length, startIdx + lineCount)
            : allLines.length;

          const snippet = allLines.slice(startIdx, endIdx).join("\n");
          const relPath = filePath.startsWith(sessionDir)
            ? filePath.slice(sessionDir.length + 1)
            : file;

          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({
              path: relPath,
              from: startIdx + 1,
              to: endIdx,
              totalLines: allLines.length,
              text: snippet
            }, null, 2)
          };
        }

        return { tool_use_id: toolCall.id, content };
      }

      case "memory_write": {
        const { file, content, append } = toolCall.input;
        if (!file || !content) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing 'file' or 'content'",
            is_error: true
          };
        }

        const sessionDir = join(SESSIONS_DIR, fromSession);
        const memoryDir = join(sessionDir, "memory");

        // Ensure memory directory exists
        if (!existsSync(memoryDir)) {
          mkdirSync(memoryDir, { recursive: true });
        }

        // Handle "today" as today's date
        let filename = file;
        if (file === "today") {
          filename = new Date().toISOString().split("T")[0] + ".md";
        }

        // Determine path - root level files go to session dir, others to memory/
        const rootFiles = ["SOUL.md", "IDENTITY.md", "MEMORY.md", "USER.md", "AGENTS.md"];
        const filePath = rootFiles.includes(filename)
          ? join(sessionDir, filename)
          : join(memoryDir, filename);

        // Default to append for daily logs
        const shouldAppend = append !== undefined ? append : filename.match(/^\d{4}-\d{2}-\d{2}\.md$/);

        if (shouldAppend && existsSync(filePath)) {
          const existing = readFileSync(filePath, "utf-8");
          writeFileSync(filePath, existing + "\n\n" + content);
        } else {
          writeFileSync(filePath, content);
        }

        return {
          tool_use_id: toolCall.id,
          content: `${shouldAppend ? "Appended to" : "Wrote"} ${filename}`
        };
      }

      case "self_reflect": {
        const { reflection, tattoo, section } = toolCall.input;
        if (!reflection && !tattoo) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Provide 'reflection' or 'tattoo'",
            is_error: true
          };
        }

        const sessionDir = join(SESSIONS_DIR, fromSession);
        const memoryDir = join(sessionDir, "memory");
        const selfPath = join(memoryDir, "SELF.md");

        // Ensure memory directory exists
        if (!existsSync(memoryDir)) {
          mkdirSync(memoryDir, { recursive: true });
        }

        // Initialize SELF.md if missing
        if (!existsSync(selfPath)) {
          writeFileSync(selfPath, "# SELF.md — Private Reflections\n\n");
        }

        const existing = readFileSync(selfPath, "utf-8");
        const today = new Date().toISOString().split("T")[0];
        const sectionHeader = section || today;

        let addition = "";
        if (tattoo) {
          // Add tattoo at the top (after title)
          const lines = existing.split("\n");
          const titleLine = lines.findIndex(l => l.startsWith("# "));
          let tattooSection = lines.findIndex(l => l.includes("## Tattoos"));

          if (tattooSection === -1) {
            // Create tattoos section right after title
            addition = `\n## Tattoos\n\n- "${tattoo}"\n`;
            const newContent = [
              ...lines.slice(0, titleLine + 1),
              addition,
              ...lines.slice(titleLine + 1)
            ].join("\n");
            writeFileSync(selfPath, newContent);
          } else {
            // Append to existing tattoos section
            const beforeTattoo = lines.slice(0, tattooSection + 1);
            const afterTattoo = lines.slice(tattooSection + 1);
            const insertPoint = afterTattoo.findIndex(l => l.startsWith("## "));
            if (insertPoint === -1) {
              afterTattoo.push(`- "${tattoo}"`);
            } else {
              afterTattoo.splice(insertPoint, 0, `- "${tattoo}"`);
            }
            writeFileSync(selfPath, [...beforeTattoo, ...afterTattoo].join("\n"));
          }
          return {
            tool_use_id: toolCall.id,
            content: `Tattoo added: "${tattoo}"`
          };
        }

        if (reflection) {
          // Append reflection with section header
          addition = `\n---\n\n## ${sectionHeader}\n\n${reflection}\n`;
          writeFileSync(selfPath, existing + addition);
          return {
            tool_use_id: toolCall.id,
            content: `Reflection added to SELF.md under "${sectionHeader}"`
          };
        }

        return { tool_use_id: toolCall.id, content: "Nothing to add" };
      }

      case "identity_get": {
        const sessionDir = join(SESSIONS_DIR, fromSession);
        const identityPath = join(sessionDir, "IDENTITY.md");

        if (!existsSync(identityPath)) {
          return {
            tool_use_id: toolCall.id,
            content: "No IDENTITY.md found. Create one with identity_update."
          };
        }

        const content = readFileSync(identityPath, "utf-8");
        // Parse basic fields
        const identity: Record<string, string> = {};
        const nameMatch = content.match(/[-*]\s*Name:\s*(.+)/i);
        const creatureMatch = content.match(/[-*]\s*Creature:\s*(.+)/i);
        const vibeMatch = content.match(/[-*]\s*Vibe:\s*(.+)/i);
        const emojiMatch = content.match(/[-*]\s*Emoji:\s*(.+)/i);

        if (nameMatch) identity.name = nameMatch[1].trim();
        if (creatureMatch) identity.creature = creatureMatch[1].trim();
        if (vibeMatch) identity.vibe = vibeMatch[1].trim();
        if (emojiMatch) identity.emoji = emojiMatch[1].trim();

        return {
          tool_use_id: toolCall.id,
          content: JSON.stringify({ parsed: identity, raw: content }, null, 2)
        };
      }

      case "identity_update": {
        const { name, creature, vibe, emoji, section, sectionContent } = toolCall.input;
        const sessionDir = join(SESSIONS_DIR, fromSession);
        const identityPath = join(sessionDir, "IDENTITY.md");

        let content = existsSync(identityPath)
          ? readFileSync(identityPath, "utf-8")
          : "# IDENTITY.md - Agent Identity\n\n";

        // Update basic fields
        const updates: string[] = [];
        if (name) {
          content = content.replace(/[-*]\s*Name:\s*.+/i, `- Name: ${name}`);
          if (!content.includes("Name:")) content += `- Name: ${name}\n`;
          updates.push(`name: ${name}`);
        }
        if (creature) {
          content = content.replace(/[-*]\s*Creature:\s*.+/i, `- Creature: ${creature}`);
          if (!content.includes("Creature:")) content += `- Creature: ${creature}\n`;
          updates.push(`creature: ${creature}`);
        }
        if (vibe) {
          content = content.replace(/[-*]\s*Vibe:\s*.+/i, `- Vibe: ${vibe}`);
          if (!content.includes("Vibe:")) content += `- Vibe: ${vibe}\n`;
          updates.push(`vibe: ${vibe}`);
        }
        if (emoji) {
          content = content.replace(/[-*]\s*Emoji:\s*.+/i, `- Emoji: ${emoji}`);
          if (!content.includes("Emoji:")) content += `- Emoji: ${emoji}\n`;
          updates.push(`emoji: ${emoji}`);
        }

        // Add/update custom section
        if (section && sectionContent) {
          const sectionRegex = new RegExp(`## ${section}[\\s\\S]*?(?=\\n## |$)`, "i");
          const newSection = `## ${section}\n\n${sectionContent}\n`;
          if (content.match(sectionRegex)) {
            content = content.replace(sectionRegex, newSection);
          } else {
            content += `\n${newSection}`;
          }
          updates.push(`section: ${section}`);
        }

        writeFileSync(identityPath, content);
        return {
          tool_use_id: toolCall.id,
          content: `Identity updated: ${updates.join(", ")}`
        };
      }

      case "soul_get": {
        const sessionDir = join(SESSIONS_DIR, fromSession);
        const soulPath = join(sessionDir, "SOUL.md");

        if (!existsSync(soulPath)) {
          return {
            tool_use_id: toolCall.id,
            content: "No SOUL.md found. Create one with soul_update."
          };
        }

        const content = readFileSync(soulPath, "utf-8");
        return { tool_use_id: toolCall.id, content };
      }

      case "soul_update": {
        const { content, section, sectionContent } = toolCall.input;
        const sessionDir = join(SESSIONS_DIR, fromSession);
        const soulPath = join(sessionDir, "SOUL.md");

        if (content) {
          // Full replacement
          writeFileSync(soulPath, content);
          return {
            tool_use_id: toolCall.id,
            content: "SOUL.md replaced entirely"
          };
        }

        if (section && sectionContent) {
          let existing = existsSync(soulPath)
            ? readFileSync(soulPath, "utf-8")
            : "# SOUL.md - Persona & Boundaries\n\n";

          const sectionRegex = new RegExp(`## ${section}[\\s\\S]*?(?=\\n## |$)`, "i");
          const newSection = `## ${section}\n\n${sectionContent}\n`;
          if (existing.match(sectionRegex)) {
            existing = existing.replace(sectionRegex, newSection);
          } else {
            existing += `\n${newSection}`;
          }

          writeFileSync(soulPath, existing);
          return {
            tool_use_id: toolCall.id,
            content: `SOUL.md section "${section}" updated`
          };
        }

        return {
          tool_use_id: toolCall.id,
          content: "Error: Provide 'content' or 'section'+'sectionContent'",
          is_error: true
        };
      }

      // ========================================================================
      // Cron/Scheduling Primitives
      // ========================================================================

      case "cron_schedule": {
        const { name, schedule, session, message } = toolCall.input;
        if (!name || !schedule || !session || !message) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameters",
            is_error: true
          };
        }
        addCron({ name, schedule, session, message });
        return {
          tool_use_id: toolCall.id,
          content: `Cron job '${name}' scheduled: ${schedule} -> ${session}`
        };
      }

      case "cron_once": {
        const { time, session, message } = toolCall.input;
        if (!time || !session || !message) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing required parameters",
            is_error: true
          };
        }
        try {
          const job = createOnceJob(time, session, message);
          addCron(job);
          return {
            tool_use_id: toolCall.id,
            content: `One-time job scheduled for ${new Date(job.runAt!).toISOString()} -> ${session}`
          };
        } catch (err: any) {
          return {
            tool_use_id: toolCall.id,
            content: `Error parsing time: ${err.message}`,
            is_error: true
          };
        }
      }

      case "cron_list": {
        const crons = getCrons();
        if (crons.length === 0) {
          return {
            tool_use_id: toolCall.id,
            content: "No cron jobs scheduled."
          };
        }
        const formatted = crons.map(c => {
          const schedule = c.once && c.runAt
            ? `once at ${new Date(c.runAt).toISOString()}`
            : c.schedule;
          return `- ${c.name}: ${schedule} -> ${c.session}`;
        }).join("\n");
        return {
          tool_use_id: toolCall.id,
          content: `Scheduled cron jobs:\n${formatted}`
        };
      }

      case "cron_cancel": {
        const { name } = toolCall.input;
        if (!name) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing 'name' parameter",
            is_error: true
          };
        }
        const removed = removeCron(name);
        if (!removed) {
          return {
            tool_use_id: toolCall.id,
            content: `Cron job '${name}' not found`,
            is_error: true
          };
        }
        return {
          tool_use_id: toolCall.id,
          content: `Cron job '${name}' cancelled`
        };
      }

      // ========================================================================
      // Event Primitives
      // ========================================================================

      case "event_emit": {
        const { event, payload } = toolCall.input;
        if (!event) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing 'event' parameter",
            is_error: true
          };
        }
        await eventBus.emitCustom(event, payload || {}, fromSession);
        return {
          tool_use_id: toolCall.id,
          content: `Event '${event}' emitted with payload: ${JSON.stringify(payload || {})}`
        };
      }

      case "event_list": {
        const coreEvents = [
          "session:create", "session:beforeInject", "session:afterInject",
          "session:responseChunk", "session:destroy",
          "channel:message", "channel:send",
          "plugin:beforeInit", "plugin:afterInit", "plugin:error",
          "config:change", "system:shutdown"
        ];
        return {
          tool_use_id: toolCall.id,
          content: `Available event types:\n\nCore events:\n${coreEvents.map(e => `- ${e}`).join("\n")}\n\nCustom events: Use 'plugin:yourname:event' format for inter-agent communication.`
        };
      }

      // ========================================================================
      // HTTP Primitives
      // ========================================================================

      case "http_fetch": {
        const { url, method = "GET", headers = {}, body, timeout = 30000 } = toolCall.input;
        if (!url) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing 'url' parameter",
            is_error: true
          };
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          const response = await fetch(url, {
            method: method.toUpperCase(),
            headers: headers as Record<string, string>,
            body: body ? body : undefined,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          const contentType = response.headers.get("content-type") || "";
          let responseBody: string;

          if (contentType.includes("application/json")) {
            const json = await response.json();
            responseBody = JSON.stringify(json, null, 2);
          } else {
            responseBody = await response.text();
          }

          // Truncate large responses
          if (responseBody.length > 10000) {
            responseBody = responseBody.substring(0, 10000) + "\n... (truncated)";
          }

          return {
            tool_use_id: toolCall.id,
            content: `HTTP ${response.status} ${response.statusText}\n\n${responseBody}`
          };
        } catch (err: any) {
          return {
            tool_use_id: toolCall.id,
            content: `HTTP request failed: ${err.message}`,
            is_error: true
          };
        }
      }

      // ========================================================================
      // Exec Primitives (Sandboxed)
      // ========================================================================

      case "exec_command": {
        const { command, cwd, timeout = 10000 } = toolCall.input;
        if (!command) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing 'command' parameter",
            is_error: true
          };
        }

        // Sandbox: Only allow safe commands
        const allowedCommands = [
          "ls", "cat", "grep", "find", "echo", "date", "pwd", "whoami",
          "head", "tail", "wc", "sort", "uniq", "diff", "env", "which",
          "file", "stat", "du", "df", "uptime", "hostname", "uname"
        ];

        const firstWord = command.trim().split(/\s+/)[0];
        if (!allowedCommands.includes(firstWord)) {
          return {
            tool_use_id: toolCall.id,
            content: `Command '${firstWord}' not allowed. Allowed commands: ${allowedCommands.join(", ")}`,
            is_error: true
          };
        }

        // Prevent shell injection
        if (command.includes(";") || command.includes("&&") || command.includes("||") ||
            command.includes("|") || command.includes("`") || command.includes("$(")) {
          return {
            tool_use_id: toolCall.id,
            content: "Shell operators not allowed (;, &&, ||, |, `, $(...))",
            is_error: true
          };
        }

        try {
          const workDir = cwd || join(SESSIONS_DIR, fromSession);
          const effectiveTimeout = Math.min(timeout, 60000); // Max 60s

          const { stdout, stderr } = await execAsync(command, {
            cwd: workDir,
            timeout: effectiveTimeout,
            maxBuffer: 1024 * 1024, // 1MB
          });

          let output = stdout;
          if (stderr) output += `\n[stderr]\n${stderr}`;
          if (output.length > 10000) {
            output = output.substring(0, 10000) + "\n... (truncated)";
          }

          return {
            tool_use_id: toolCall.id,
            content: output || "(no output)"
          };
        } catch (err: any) {
          return {
            tool_use_id: toolCall.id,
            content: `Command failed: ${err.message}`,
            is_error: true
          };
        }
      }

      // ========================================================================
      // Notification Primitives
      // ========================================================================

      case "notify": {
        const { message, level = "info", channel } = toolCall.input;
        if (!message) {
          return {
            tool_use_id: toolCall.id,
            content: "Error: Missing 'message' parameter",
            is_error: true
          };
        }

        // Log to appropriate level
        const logLevel = level === "error" ? "error" : level === "warn" ? "warn" : "info";
        logger[logLevel](`[NOTIFY] ${message}`);

        // Emit notification event for plugins to handle
        await eventBus.emitCustom("notification:send", {
          message,
          level,
          channel,
          fromSession,
        }, fromSession);

        return {
          tool_use_id: toolCall.id,
          content: `Notification sent: [${level.toUpperCase()}] ${message}`
        };
      }

      // ========================================================================
      // Memory Search (Semantic - like clawdbot)
      // ========================================================================

      case "memory_search": {
        const { query, maxResults = 10, minScore = 0.35 } = toolCall.input;
        if (!query) {
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({ results: [], error: "Missing 'query' parameter" }),
            is_error: true
          };
        }

        const sessionDir = join(SESSIONS_DIR, fromSession);
        const memoryDir = join(sessionDir, "memory");

        // Collect all searchable files
        const filesToSearch: string[] = [];

        // Root-level identity files
        for (const f of ["MEMORY.md", "IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md"]) {
          const fp = join(sessionDir, f);
          if (existsSync(fp)) filesToSearch.push(fp);
        }

        // Memory directory files
        if (existsSync(memoryDir)) {
          const memFiles = readdirSync(memoryDir).filter(f => f.endsWith(".md"));
          for (const f of memFiles) {
            filesToSearch.push(join(memoryDir, f));
          }
        }

        if (filesToSearch.length === 0) {
          return {
            tool_use_id: toolCall.id,
            content: "No memory files found. Create files in memory/ or root-level MEMORY.md, IDENTITY.md, etc."
          };
        }

        // Search each file for query terms
        const queryTerms = query.toLowerCase().split(/\s+/).filter((t: string) => t.length > 2);
        const results: Array<{
          path: string;
          relPath: string;
          lineStart: number;
          lineEnd: number;
          snippet: string;
          score: number;
        }> = [];

        for (const filePath of filesToSearch) {
          const relPath = filePath.startsWith(sessionDir)
            ? filePath.slice(sessionDir.length + 1)
            : filePath;
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          // Score each chunk (5-line window)
          const chunkSize = 5;
          for (let i = 0; i < lines.length; i += chunkSize) {
            const chunk = lines.slice(i, i + chunkSize).join("\n");
            const chunkLower = chunk.toLowerCase();

            // Score based on term matches
            let score = 0;
            for (const term of queryTerms) {
              if (chunkLower.includes(term)) {
                score += 1;
                // Boost for exact phrase match
                if (chunkLower.includes(query.toLowerCase())) {
                  score += 2;
                }
              }
            }

            if (score > 0) {
              results.push({
                path: filePath,
                relPath,
                lineStart: i + 1,
                lineEnd: Math.min(i + chunkSize, lines.length),
                snippet: chunk.substring(0, 300) + (chunk.length > 300 ? "..." : ""),
                score,
              });
            }
          }
        }

        // Normalize scores to 0-1 range (max possible is queryTerms.length * 3)
        const maxPossibleScore = queryTerms.length * 3;
        for (const r of results) {
          r.score = maxPossibleScore > 0 ? r.score / maxPossibleScore : 0;
        }

        // Sort by score descending, filter by minScore, take top N
        results.sort((a, b) => b.score - a.score);
        const filteredResults = results.filter(r => r.score >= minScore);
        const topResults = filteredResults.slice(0, maxResults);

        if (topResults.length === 0) {
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({
              results: [],
              query,
              message: `No matches found for "${query}" above minScore ${minScore}`
            }, null, 2)
          };
        }

        // Format results like clawdbot
        const formatted = topResults.map((r, i) => {
          return `[${i + 1}] ${r.relPath}:${r.lineStart}-${r.lineEnd} (score: ${r.score.toFixed(2)})\n${r.snippet}`;
        }).join("\n\n---\n\n");

        return {
          tool_use_id: toolCall.id,
          content: `Found ${topResults.length} results for "${query}":\n\n${formatted}`
        };
      }

      // ========================================================================
      // Memory Get (like clawdbot's memory_get)
      // ========================================================================

      case "memory_get": {
        const { path: relPath, from, lines: lineCount } = toolCall.input;
        if (!relPath) {
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({ path: "", text: "", error: "Missing 'path' parameter" }),
            is_error: true
          };
        }

        const sessionDir = join(SESSIONS_DIR, fromSession);
        const memoryDir = join(sessionDir, "memory");

        // Resolve path - could be relative from session root or memory dir
        let filePath = join(sessionDir, relPath);
        if (!existsSync(filePath)) {
          filePath = join(memoryDir, relPath);
        }
        if (!existsSync(filePath)) {
          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({ path: relPath, text: "", error: `File not found: ${relPath}` }),
            is_error: true
          };
        }

        const content = readFileSync(filePath, "utf-8");
        const allLines = content.split("\n");

        // Extract snippet if from/lines specified
        if (from !== undefined && from > 0) {
          const startIdx = Math.max(0, from - 1); // Convert to 0-indexed
          const endIdx = lineCount !== undefined
            ? Math.min(allLines.length, startIdx + lineCount)
            : allLines.length;

          const snippet = allLines.slice(startIdx, endIdx).join("\n");

          return {
            tool_use_id: toolCall.id,
            content: JSON.stringify({
              path: relPath,
              from: startIdx + 1,
              to: endIdx,
              totalLines: allLines.length,
              text: snippet
            }, null, 2)
          };
        }

        // Return full file content
        return {
          tool_use_id: toolCall.id,
          content: JSON.stringify({
            path: relPath,
            totalLines: allLines.length,
            text: content
          }, null, 2)
        };
      }

      default:
        return {
          tool_use_id: toolCall.id,
          content: `Error: Unknown tool '${toolCall.name}'`,
          is_error: true
        };
    }
  } catch (error) {
    return {
      tool_use_id: toolCall.id,
      content: `Error executing ${toolCall.name}: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}

// Ensure directories exist
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ============================================================================
// Serialized Inject Queue per Session
// ============================================================================

interface PendingInject {
  promise: Promise<InjectResult>;
  abortController: AbortController;
  startTime: number;
}

// Track pending injects per session for serialization
const pendingInjects: Map<string, PendingInject> = new Map();

/**
 * Cancel any running inject for a session
 */
export function cancelInject(session: string): boolean {
  const pending = pendingInjects.get(session);
  if (pending) {
    pending.abortController.abort();
    pendingInjects.delete(session);
    logger.info(`[sessions] Cancelled inject for session: ${session}`);
    return true;
  }
  return false;
}

/**
 * Check if a session has a pending inject
 */
export function hasPendingInject(session: string): boolean {
  return pendingInjects.has(session);
}

/**
 * Wait for pending inject to complete (for serialization)
 */
async function waitForPendingInject(session: string): Promise<void> {
  const pending = pendingInjects.get(session);
  if (pending) {
    try {
      await pending.promise;
    } catch (e) {
      // Ignore errors from previous inject
    }
  }
}

export interface Session {
  name: string;
  id?: string;
  context?: string;
  created: number;
  provider?: ProviderConfig;
}

export function getSessions(): Record<string, string> {
  return existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) : {};
}

export function saveSessionId(name: string, id: string): void {
  const sessions = getSessions();
  sessions[name] = id;
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export function deleteSessionId(name: string): void {
  const sessions = getSessions();
  delete sessions[name];
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export function getSessionContext(name: string): string | undefined {
  const contextFile = join(SESSIONS_DIR, `${name}.md`);
  return existsSync(contextFile) ? readFileSync(contextFile, "utf-8") : undefined;
}

export function setSessionContext(name: string, context: string): void {
  const contextFile = join(SESSIONS_DIR, `${name}.md`);
  writeFileSync(contextFile, context);
}

export function getSessionProvider(name: string): ProviderConfig | undefined {
  const providerFile = join(SESSIONS_DIR, `${name}.provider.json`);
  return existsSync(providerFile) ? JSON.parse(readFileSync(providerFile, "utf-8")) : undefined;
}

export function setSessionProvider(name: string, provider: ProviderConfig): void {
  const providerFile = join(SESSIONS_DIR, `${name}.provider.json`);
  writeFileSync(providerFile, JSON.stringify(provider, null, 2));
}

export async function deleteSession(name: string, reason?: string): Promise<void> {
  // Get conversation history before deletion
  const history = getConversationHistory(name);
  
  deleteSessionId(name);
  const contextFile = join(SESSIONS_DIR, `${name}.md`);
  if (existsSync(contextFile)) unlinkSync(contextFile);
  const providerFile = join(SESSIONS_DIR, `${name}.provider.json`);
  if (existsSync(providerFile)) unlinkSync(providerFile);
  
  // Emit session:destroy event
  await emitSessionDestroy(name, history, reason);
}

// Get conversation history for a session
function getConversationHistory(name: string): any[] {
  const logPath = getConversationLogPath(name);
  if (!existsSync(logPath)) return [];
  
  try {
    const content = readFileSync(logPath, "utf-8");
    return content
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function listSessions(): Session[] {
  const sessions = getSessions();
  return Object.keys(sessions).map(name => ({
    name,
    id: sessions[name],
    context: getSessionContext(name),
    created: 0, // TODO: track creation time
  }));
}

// Conversation log functions
function getConversationLogPath(name: string): string {
  return join(SESSIONS_DIR, `${name}.conversation.jsonl`);
}

export function appendToConversationLog(name: string, entry: ConversationEntry): void {
  const logPath = getConversationLogPath(name);
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(logPath, line, "utf-8");
}

/**
 * Log a message to conversation history without triggering a response
 * Used by plugins to capture context from messages not directed at the bot
 */
export function logMessage(
  session: string,
  content: string,
  options?: { from?: string; channel?: any }
): void {
  appendToConversationLog(session, {
    ts: Date.now(),
    from: options?.from || "unknown",
    content,
    type: "message",
    channel: options?.channel,
  });
}

export function readConversationLog(name: string, limit?: number): ConversationEntry[] {
  const logPath = getConversationLogPath(name);
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(l => l);
  const entries = lines.map(line => JSON.parse(line) as ConversationEntry);

  if (limit && limit > 0) {
    return entries.slice(-limit);
  }
  return entries;
}

export interface InjectOptions {
  silent?: boolean;
  onStream?: StreamCallback;
  from?: string;
  channel?: ChannelRef;
  images?: string[];  // URLs of images to include in the message
}

export interface InjectResult {
  response: string;
  sessionId: string;
  cost: number;
}

export interface MultimodalMessage {
  text: string;
  images?: string[];  // URLs of images
}

export async function inject(
  name: string,
  message: string | MultimodalMessage,
  options?: InjectOptions
): Promise<InjectResult> {
  // SERIALIZATION: Wait for any pending inject on this session to complete
  await waitForPendingInject(name);
  
  // Create abort controller for cancellation
  const abortController = new AbortController();
  const abortSignal = abortController.signal;
  
  // Create the inject promise
  const injectPromise = executeInject(name, message, options, abortSignal);
  
  // Track this pending inject
  pendingInjects.set(name, {
    promise: injectPromise,
    abortController,
    startTime: Date.now(),
  });
  
  try {
    const result = await injectPromise;
    return result;
  } finally {
    // Clean up pending inject
    pendingInjects.delete(name);
  }
}

/**
 * Internal inject execution
 */
async function executeInject(
  name: string,
  message: string | MultimodalMessage,
  options?: InjectOptions,
  abortSignal?: AbortSignal
): Promise<InjectResult> {
  const sessions = getSessions();
  const existingSessionId = sessions[name];
  const context = getSessionContext(name);
  const silent = options?.silent ?? false;
  const onStream = options?.onStream;
  const from = options?.from ?? "cli";
  const channel = options?.channel;
  const collected: string[] = [];
  let sessionId = existingSessionId || "";
  let cost = 0;

  // Check if aborted
  if (abortSignal?.aborted) {
    throw new Error("Inject cancelled");
  }

  // Normalize message to MultimodalMessage format
  let messageText: string;
  let messageImages: string[] = options?.images || [];
  
  if (typeof message === 'string') {
    messageText = message;
  } else {
    messageText = message.text;
    if (message.images) {
      messageImages = messageImages.concat(message.images);
    }
  }

  // Emit session:create event for new sessions
  if (!existingSessionId) {
    await emitSessionCreate(name, { context, provider: getSessionProvider(name) });
  }

  if (!silent) {
    logger.info(`[wopr] Injecting into session: ${name}`);
    if (existingSessionId) {
      logger.info(`[wopr] Resuming session: ${existingSessionId}`);
    } else {
      logger.info(`[wopr] Creating new session`);
    }
    if (messageImages.length > 0) {
      logger.info(`[wopr] Images: ${messageImages.length}`);
    }
  }

  // Assemble context using the new provider system
  const messageInfo: MessageInfo = {
    content: messageText,
    from,
    channel,
    timestamp: Date.now()
  };
  
  const assembled = await assembleContext(name, messageInfo);
  
  if (!silent) {
    if (assembled.sources.length > 0) {
      logger.info(`[wopr] Context sources: ${assembled.sources.join(", ")}`);
    }
    if (assembled.warnings.length > 0) {
      assembled.warnings.forEach(w => logger.warn(`[wopr] Warning: ${w}`));
    }
  }
  
  // Log context to conversation log
  if (assembled.context) {
    appendToConversationLog(name, {
      ts: Date.now(),
      from: "system",
      content: assembled.context,
      type: "context",
      channel,
    });
  }

  // Emit incoming message event for hooks (can transform or block)
  const incomingResult = await emitMutableIncoming(name, messageText, from, channel);

  if (incomingResult.prevented) {
    appendToConversationLog(name, {
      ts: Date.now(),
      from: "system",
      content: "Message blocked by hook.",
      type: "context",
      channel,
    });
    return { response: "", sessionId, cost: 0 };
  }

  const processedMessage = incomingResult.message;

  appendToConversationLog(name, {
    ts: Date.now(),
    from,
    content: processedMessage + (messageImages.length > 0 ? `\n[Images: ${messageImages.join(', ')}]` : ''),
    type: "message",
    channel,
  });

  // Build full message (context + user message)
  // Context from providers goes before the actual message for conversation flow
  const fullMessage = assembled.context
    ? `${assembled.context}\n\n${processedMessage}`
    : processedMessage;
  
  // System context is the assembled system + any session file context as fallback
  const fullContext = assembled.system || context || `You are WOPR session "${name}".`;

  // Load provider config from session or auto-detect available provider
  let providerConfig = getSessionProvider(name);
  if (!providerConfig) {
    // Auto-detect: use first available provider
    const available = providerRegistry.listProviders().filter(p => p.available);
    if (available.length === 0) {
      throw new Error("No providers available. Configure at least one provider or set session provider.");
    }
    providerConfig = {
      name: available[0].id,
    };
    // Save this provider config for the session
    setSessionProvider(name, providerConfig);
  }

  let resolvedProvider: any = null;
  let providerUsed = "unknown";

  try {
    // Resolve provider with fallback chain
    resolvedProvider = await providerRegistry.resolveProvider(providerConfig);
    providerUsed = resolvedProvider.name;
    if (!silent) logger.info(`[wopr] Using provider: ${providerUsed}`);
  } catch (err) {
    // If provider resolution fails, try fallback to Anthropic SDK directly
    if (!silent) logger.error(`[wopr] Provider resolution failed: ${err}`);
    if (!silent) logger.info(`[wopr] Falling back to direct Anthropic query`);
    resolvedProvider = null;
  }

  // Execute query using resolved provider or fallback to direct query
  // Get A2A tools if enabled
  const a2aTools = getA2ATools();
  
  let q: any;
  if (resolvedProvider) {
    // Use provider registry to execute query
    q = resolvedProvider.client.query({
      prompt: fullMessage,
      systemPrompt: fullContext,
      resume: existingSessionId,
      model: resolvedProvider.provider.defaultModel,
      images: messageImages.length > 0 ? messageImages : undefined,
      tools: a2aTools,
    });
  } else {
    // Fallback: use hardcoded Anthropic query
    // Note: fallback path doesn't support images (use provider plugins for full features)
    const fallbackOptions: any = {
      resume: existingSessionId,
      systemPrompt: fullContext,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
    // Add tools if A2A is enabled (Agent SDK supports tools in options)
    if (a2aTools) {
      fallbackOptions.tools = a2aTools;
    }
    q = query({
      prompt: fullMessage,
      options: fallbackOptions,
    });
  }

  for await (const msg of q) {
    // Check for cancellation
    if (abortSignal?.aborted) {
      logger.info(`[wopr] Inject cancelled mid-stream for session: ${name}`);
      throw new Error("Inject cancelled");
    }
    
    logger.info(`[inject] Got msg type: ${msg.type}`, JSON.stringify(msg).substring(0, 200));
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          saveSessionId(name, sessionId);
          if (!silent) logger.info(`[wopr] Session ID: ${sessionId}`);
        }
        break;
      case "assistant":
        logger.info(`[inject] Processing assistant msg, content blocks: ${msg.message?.content?.length || 0}`);
        for (const block of msg.message.content) {
          logger.info(`[inject]   Block type: ${block.type}`);
          if (block.type === "text") {
            collected.push(block.text);
            if (!silent) logger.info(block.text);
            const streamMsg: StreamMessage = { type: "text", content: block.text };
            if (onStream) onStream(streamMsg);
            emitStream(name, from, streamMsg);
            // Emit new event bus event for response chunks
            await emitSessionResponseChunk(name, messageText, collected.join(""), from, block.text);
          } else if (block.type === "tool_use") {
            if (!silent) logger.info(`[tool] ${block.name}`);
            const streamMsg: StreamMessage = { type: "tool_use", content: "", toolName: block.name };
            if (onStream) onStream(streamMsg);
            emitStream(name, from, streamMsg);
            
            // Execute A2A tool and collect result
            if (isA2AEnabled()) {
              const toolCall: ToolCall = {
                id: block.id,
                name: block.name,
                input: block.input || {}
              };
              logger.info(`[a2a] Executing ${block.name} from session ${name}`);
              const result = await executeA2ATool(toolCall, name);
              // Add tool result to collected for context
              collected.push(`\n[Tool ${block.name} result]: ${result.content.substring(0, 500)}${result.content.length > 500 ? '...' : ''}\n`);
            }
          }
        }
        break;
      case "result":
        if (msg.subtype === "success") {
          cost = msg.total_cost_usd;
          if (!silent) logger.info(`\n[wopr] Complete (${providerUsed}). Cost: $${cost.toFixed(4)}`);
          const streamMsg: StreamMessage = { type: "complete", content: `Cost: $${cost.toFixed(4)}` };
          if (onStream) onStream(streamMsg);
          emitStream(name, from, streamMsg);
        } else {
          if (!silent) logger.error(`[wopr] Error: ${msg.subtype}`);
          const streamMsg: StreamMessage = { type: "error", content: msg.subtype };
          if (onStream) onStream(streamMsg);
          emitStream(name, from, streamMsg);
        }
        break;
    }
  }

  let response = collected.join("");

  // Emit outgoing response event for hooks (can transform or block)
  const outgoingResult = await emitMutableOutgoing(name, response, from, channel);

  if (outgoingResult.prevented) {
    appendToConversationLog(name, {
      ts: Date.now(),
      from: "system",
      content: "Response blocked by hook.",
      type: "context",
      channel,
    });
    return { response: "", sessionId, cost };
  }

  response = outgoingResult.response;

  // Log response to conversation log
  if (response) {
    appendToConversationLog(name, {
      ts: Date.now(),
      from: "WOPR",
      content: response,
      type: "response",
      channel,
    });
  }

  // Emit final injection event for plugins that want complete responses
  emitInjection(name, from, messageText, response);

  // Update last trigger timestamp for progressive context
  // This marks the end of this interaction, so next trigger gets context since now
  const { updateLastTriggerTimestamp } = await import("./context.js");
  updateLastTriggerTimestamp(name);

  return { response, sessionId, cost };
}

