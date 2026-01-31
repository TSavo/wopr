/**
 * A2A (Agent-to-Agent) MCP Server
 *
 * Provides WOPR's built-in tools as an MCP server that the Claude Agent SDK
 * can use. Plugins can register additional tools via registerA2ATool().
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { logger } from "../logger.js";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import { SESSIONS_DIR, GLOBAL_IDENTITY_DIR } from "../paths.js";
import { config as centralConfig } from "./config.js";
import {
  getCrons,
  addCron,
  removeCron,
  createOnceJob,
  getCronHistory,
} from "./cron.js";
import { eventBus } from "./events.js";
import {
  getContext,
  checkToolAccess,
  isEnforcementEnabled,
  type PolicyCheckResult,
} from "../security/index.js";

const execAsync = promisify(exec);

// Global identity/memory directory (checked first before session-specific)
const GLOBAL_MEMORY_DIR = join(GLOBAL_IDENTITY_DIR, "memory");

/**
 * Get the path to a root-level file, checking global identity first
 * Returns { path, isGlobal } where isGlobal indicates if it came from global identity
 */
function resolveRootFile(sessionDir: string, filename: string): { path: string; isGlobal: boolean; exists: boolean } {
  const globalPath = join(GLOBAL_IDENTITY_DIR, filename);
  if (existsSync(globalPath)) {
    return { path: globalPath, isGlobal: true, exists: true };
  }
  const sessionPath = join(sessionDir, filename);
  return { path: sessionPath, isGlobal: false, exists: existsSync(sessionPath) };
}

/**
 * Get the path to a memory file, checking global memory first
 */
function resolveMemoryFile(sessionDir: string, filename: string): { path: string; isGlobal: boolean; exists: boolean } {
  const sessionMemoryDir = join(sessionDir, "memory");
  const globalPath = join(GLOBAL_MEMORY_DIR, filename);
  if (existsSync(globalPath)) {
    return { path: globalPath, isGlobal: true, exists: true };
  }
  const sessionPath = join(sessionMemoryDir, filename);
  return { path: sessionPath, isGlobal: false, exists: existsSync(sessionPath) };
}

/**
 * List all memory files from both global and session directories
 */
function listAllMemoryFiles(sessionDir: string): string[] {
  const files = new Set<string>();
  const sessionMemoryDir = join(sessionDir, "memory");

  // Add global memory files first
  if (existsSync(GLOBAL_MEMORY_DIR)) {
    readdirSync(GLOBAL_MEMORY_DIR)
      .filter(f => f.endsWith(".md"))
      .forEach(f => files.add(f));
  }

  // Add session memory files (may override global)
  if (existsSync(sessionMemoryDir)) {
    readdirSync(sessionMemoryDir)
      .filter(f => f.endsWith(".md"))
      .forEach(f => files.add(f));
  }

  return Array.from(files);
}

// Type for registered tools (before we build the MCP server)
interface RegisteredTool {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  handler: (args: any, context: ToolContext) => Promise<any>;
}

// Context passed to tool handlers
export interface ToolContext {
  sessionName: string;  // The WOPR session calling this tool
}

/**
 * Check if a tool can be used in the current security context
 *
 * @param toolName - Name of the tool to check
 * @param sessionName - Session making the request
 * @returns Policy check result with allowed status and reason
 */
function checkToolPermission(toolName: string, sessionName: string): PolicyCheckResult {
  // Get the security context for this session (set during inject)
  const securityContext = getContext(sessionName);

  if (!securityContext) {
    // No security context = legacy behavior, allow with warning
    logger.warn(`[a2a-mcp] No security context for session ${sessionName}, allowing ${toolName}`);
    return { allowed: true, warning: "No security context" };
  }

  // Check if tool access is allowed
  return securityContext.canUseTool(toolName);
}

/**
 * Wrapper to enforce security checks on tool handlers
 *
 * @param toolName - Name of the tool
 * @param sessionName - Session making the request
 * @param handler - The actual tool handler
 */
async function withSecurityCheck<T>(
  toolName: string,
  sessionName: string,
  handler: () => Promise<T>
): Promise<T | { content: { type: string; text: string }[]; isError: boolean }> {
  const check = checkToolPermission(toolName, sessionName);

  if (!check.allowed) {
    if (isEnforcementEnabled()) {
      logger.warn(`[a2a-mcp] Tool ${toolName} denied for session ${sessionName}: ${check.reason}`);
      return {
        content: [{ type: "text", text: `Access denied: ${check.reason}` }],
        isError: true,
      };
    } else {
      // Warn mode - log but continue
      logger.warn(`[a2a-mcp] Tool ${toolName} would be denied: ${check.reason}`);
    }
  }

  return handler();
}

// Registry of additional tools from plugins
const pluginTools: Map<string, RegisteredTool> = new Map();

// Track if MCP server needs rebuild
let mcpServerDirty = true;
let cachedMcpServer: any = null;

/**
 * Register an A2A tool from a plugin
 *
 * @example
 * registerA2ATool({
 *   name: "peer_send",
 *   description: "Send a message to a peer",
 *   schema: z.object({
 *     peer: z.string().describe("Peer ID"),
 *     message: z.string().describe("Message to send")
 *   }),
 *   handler: async (args, ctx) => {
 *     return { result: "sent" };
 *   }
 * });
 */
export function registerA2ATool(toolDef: RegisteredTool): void {
  logger.info(`[a2a-mcp] Registering tool: ${toolDef.name}`);
  pluginTools.set(toolDef.name, toolDef);
  mcpServerDirty = true;
}

/**
 * Unregister a tool (e.g., when plugin unloads)
 */
export function unregisterA2ATool(name: string): boolean {
  const removed = pluginTools.delete(name);
  if (removed) {
    mcpServerDirty = true;
    logger.info(`[a2a-mcp] Unregistered tool: ${name}`);
  }
  return removed;
}

/**
 * List all registered tools (core + plugins)
 */
export function listA2ATools(): string[] {
  const coreTools = [
    "sessions_list", "sessions_send", "sessions_history", "sessions_spawn",
    "config_get", "config_set", "config_provider_defaults",
    "memory_read", "memory_write", "memory_search", "memory_get",
    "self_reflect", "identity_get", "identity_update", "soul_get", "soul_update",
    "cron_schedule", "cron_once", "cron_list", "cron_cancel",
    "event_emit", "event_list",
    "security_whoami", "security_check",
    "http_fetch", "exec_command", "notify"
  ];
  return [...coreTools, ...pluginTools.keys()];
}

// Forward declarations for functions that need session imports
// We'll set these via a setter to avoid circular imports
let injectFn: ((name: string, message: string, options?: any) => Promise<any>) | null = null;
let getSessions: (() => Record<string, string>) | null = null;
let readConversationLog: ((name: string, limit?: number) => any[]) | null = null;
let setSessionContext: ((name: string, context: string) => void) | null = null;

/**
 * Set session functions (called from sessions.ts to avoid circular imports)
 */
export function setSessionFunctions(fns: {
  inject: typeof injectFn;
  getSessions: typeof getSessions;
  readConversationLog: typeof readConversationLog;
  setSessionContext: typeof setSessionContext;
}): void {
  injectFn = fns.inject;
  getSessions = fns.getSessions;
  readConversationLog = fns.readConversationLog;
  setSessionContext = fns.setSessionContext;
}

/**
 * Build or return cached MCP server
 * The server is rebuilt when tools are registered/unregistered
 */
export function getA2AMcpServer(sessionName: string): any {
  if (!mcpServerDirty && cachedMcpServer) {
    return cachedMcpServer;
  }

  logger.info(`[a2a-mcp] Building MCP server with ${pluginTools.size} plugin tools`);

  // Build tools array
  const tools: any[] = [];

  // Helper to create tool context
  const makeContext = (): ToolContext => ({ sessionName });

  // ========================================================================
  // Session Tools
  // ========================================================================

  tools.push(
    tool(
      "sessions_list",
      "List all active WOPR sessions with metadata. Use this to discover other sessions/agents you can communicate with.",
      {
        limit: z.number().optional().describe("Maximum number of sessions to return (default: 50)")
      },
      async (args) => {
        if (!getSessions) throw new Error("Session functions not initialized");
        const sessions = getSessions();
        const sessionList = Object.keys(sessions).map(key => ({
          name: key,
          id: sessions[key]
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ sessions: sessionList, count: sessionList.length }, null, 2) }]
        };
      }
    )
  );

  tools.push(
    tool(
      "sessions_send",
      "Send a message to another WOPR session. Use this to delegate tasks, ask questions, or coordinate with other sessions.",
      {
        session: z.string().describe("Target session name (e.g., 'code-reviewer', 'discord-123456')"),
        message: z.string().describe("The message to send to the target session")
      },
      async (args) => {
        // SECURITY: Check cross.inject capability
        return withSecurityCheck("sessions_send", sessionName, async () => {
          if (!injectFn) throw new Error("Session functions not initialized");
          const { session, message } = args;

          // Log the cross-session inject attempt
          logger.info(`[a2a-mcp] sessions_send: ${sessionName} -> ${session} (${message.length} chars)`);

          // Prevent self-inject (would deadlock due to serialization)
          if (session === sessionName) {
            logger.warn(`[a2a-mcp] sessions_send: Blocking self-inject attempt from ${sessionName}`);
            return {
              content: [{ type: "text", text: "Error: Cannot send message to yourself - this would cause a deadlock" }],
              isError: true
            };
          }

          try {
            const response = await injectFn(session, message, { from: sessionName, silent: true });
            logger.info(`[a2a-mcp] sessions_send: ${sessionName} -> ${session} completed`);
            return {
              content: [{ type: "text", text: `Response from ${session}:\n${response.response}` }]
            };
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.error(`[a2a-mcp] sessions_send: ${sessionName} -> ${session} failed: ${errMsg}`);
            return {
              content: [{ type: "text", text: `Error sending to ${session}: ${errMsg}` }],
              isError: true
            };
          }
        });
      }
    )
  );

  tools.push(
    tool(
      "sessions_history",
      "Fetch conversation history from a session. Use full=true to get complete untruncated history (the session mirror). Requires cross.read capability for reading other sessions' history.",
      {
        session: z.string().describe("Session name to fetch history from"),
        limit: z.number().optional().describe("Number of recent messages to fetch (default: 10, ignored when full=true)"),
        full: z.boolean().optional().describe("Return complete untruncated history - the full mirror (default: false)"),
        offset: z.number().optional().describe("Skip this many messages from the start (for pagination, only with full=true)")
      },
      async (args) => {
        // SECURITY: Check session.history capability, plus cross.read for other sessions
        return withSecurityCheck("sessions_history", sessionName, async () => {
          if (!readConversationLog) throw new Error("Session functions not initialized");
          const { session, limit = 10, full = false, offset = 0 } = args;

          // SECURITY: If reading another session's history, require cross.read capability
          if (session !== sessionName) {
            const ctx = getContext(sessionName);
            if (ctx && !ctx.hasCapability("cross.read")) {
              if (isEnforcementEnabled()) {
                return {
                  content: [{ type: "text", text: `Access denied: Reading other sessions' history requires 'cross.read' capability` }],
                  isError: true,
                };
              } else {
                logger.warn(`[a2a-mcp] sessions_history: ${sessionName} reading ${session} history without cross.read capability`);
              }
            }
          }

          if (full) {
            // FULL MIRROR MODE: Return complete untruncated history with pagination
            const allEntries = readConversationLog(session, 0); // 0 = no limit
            const totalCount = allEntries.length;
            const pageSize = limit > 0 ? limit : 100; // Use limit as page size, default 100
            const startIdx = offset;
            const endIdx = startIdx + pageSize;
            const entries = allEntries.slice(startIdx, endIdx);
            const hasMore = endIdx < totalCount;
            const nextOffset = hasMore ? endIdx : null;

            // Return as structured JSON with full content
            const history = entries.map((e: any) => ({
              ts: e.ts,
              iso: new Date(e.ts).toISOString(),
              from: e.from,
              type: e.type,
              content: e.content, // FULL content, no truncation
              channel: e.channel
            }));

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  session,
                  total: totalCount,
                  offset: startIdx,
                  pageSize,
                  returned: history.length,
                  hasMore,
                  nextOffset,
                  history
                }, null, 2)
              }]
            };
          } else {
            // SUMMARY MODE: Backwards compatible truncated view
            const entries = readConversationLog(session, Math.min(limit, 50));
            const formatted = entries.map((e: any) =>
              `[${new Date(e.ts).toISOString()}] ${e.from}: ${e.content?.substring(0, 200)}${e.content?.length > 200 ? '...' : ''}`
            ).join('\n');
            return {
              content: [{ type: "text", text: formatted || "No history found for this session." }]
            };
          }
        });
      }
    )
  );

  tools.push(
    tool(
      "sessions_spawn",
      "Create a new session with a specific purpose. The new session will be initialized with your description.",
      {
        name: z.string().describe("Name for the new session (e.g., 'python-reviewer')"),
        purpose: z.string().describe("Describe what this session should do (becomes its system context)")
      },
      async (args) => {
        // SECURITY: Check session.spawn capability
        return withSecurityCheck("sessions_spawn", sessionName, async () => {
          if (!setSessionContext) throw new Error("Session functions not initialized");
          const { name, purpose } = args;
          setSessionContext(name, purpose);
          return {
            content: [{ type: "text", text: `Session '${name}' created successfully with purpose: ${purpose}` }]
          };
        });
      }
    )
  );

  // ========================================================================
  // Config Tools
  // ========================================================================

  tools.push(
    tool(
      "config_get",
      "Get a WOPR configuration value. Use dot notation for nested keys (e.g., 'providers.codex.model'). Sensitive values (API keys, secrets) are redacted for security.",
      {
        key: z.string().optional().describe("Config key to retrieve (dot notation). Omit to get all config.")
      },
      async (args) => {
        // SECURITY: Check config.read capability
        return withSecurityCheck("config_get", sessionName, async () => {
          await centralConfig.load();
          const { key } = args;

          // Redact sensitive values to prevent API key leakage
          const redactSensitive = (obj: any, path: string = ""): any => {
            if (obj === null || obj === undefined) return obj;
            if (typeof obj !== "object") {
              // Check if this is a sensitive field by name
              const keyName = path.split(".").pop()?.toLowerCase() || "";
              const sensitiveKeys = ["apikey", "api_key", "secret", "token", "password", "private", "privatekey", "private_key"];
              if (sensitiveKeys.some(sk => keyName.includes(sk))) {
                return "[REDACTED]";
              }
              return obj;
            }
            if (Array.isArray(obj)) {
              return obj.map((item, i) => redactSensitive(item, `${path}[${i}]`));
            }
            const result: any = {};
            for (const [k, v] of Object.entries(obj)) {
              result[k] = redactSensitive(v, path ? `${path}.${k}` : k);
            }
            return result;
          };

          if (key) {
            const value = centralConfig.getValue(key);
            if (value === undefined) {
              return { content: [{ type: "text", text: `Config key "${key}" not found` }], isError: true };
            }
            const redactedValue = redactSensitive(value, key);
            return { content: [{ type: "text", text: JSON.stringify({ key, value: redactedValue }, null, 2) }] };
          }
          const redactedConfig = redactSensitive(centralConfig.get());
          return { content: [{ type: "text", text: JSON.stringify(redactedConfig, null, 2) }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "config_set",
      "Set a WOPR configuration value. Use dot notation for nested keys. Changes are persisted immediately.",
      {
        key: z.string().describe("Config key to set (dot notation)"),
        value: z.string().describe("Value to set (strings, numbers, booleans, or JSON for objects)")
      },
      async (args) => {
        // SECURITY: Check config.write capability
        return withSecurityCheck("config_set", sessionName, async () => {
          const { key, value } = args;
          await centralConfig.load();
          let parsedValue: any = value;
          try { parsedValue = JSON.parse(value); } catch { /* keep as string */ }
          centralConfig.setValue(key, parsedValue);
          await centralConfig.save();
          return { content: [{ type: "text", text: `Config set: ${key} = ${JSON.stringify(parsedValue)}` }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "config_provider_defaults",
      "Get or set default settings for a provider.",
      {
        provider: z.string().describe("Provider ID (e.g., 'codex', 'anthropic')"),
        model: z.string().optional().describe("Default model for this provider"),
        reasoningEffort: z.string().optional().describe("For Codex: minimal/low/medium/high/xhigh")
      },
      async (args) => {
        const { provider, model, reasoningEffort } = args;
        await centralConfig.load();

        if (!model && !reasoningEffort) {
          const defaults = centralConfig.getProviderDefaults(provider);
          if (!defaults || Object.keys(defaults).length === 0) {
            return { content: [{ type: "text", text: `No defaults set for provider '${provider}'` }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ provider, defaults }, null, 2) }] };
        }

        if (model) centralConfig.setProviderDefault(provider, "model", model);
        if (reasoningEffort) centralConfig.setProviderDefault(provider, "reasoningEffort", reasoningEffort);
        await centralConfig.save();

        const updated = centralConfig.getProviderDefaults(provider);
        return { content: [{ type: "text", text: `Provider defaults updated:\n${JSON.stringify(updated, null, 2)}` }] };
      }
    )
  );

  // ========================================================================
  // Memory Tools
  // ========================================================================

  tools.push(
    tool(
      "memory_read",
      "Read a memory file. Checks global identity first, then session-specific. Supports daily logs, SELF.md, or topic files.",
      {
        file: z.string().optional().describe("Filename to read (e.g., 'SELF.md', '2026-01-24.md')"),
        from: z.number().optional().describe("Starting line number (1-indexed)"),
        lines: z.number().optional().describe("Number of lines to read"),
        days: z.number().optional().describe("For daily logs: read last N days (default: 7)")
      },
      async (args) => {
        const { file, days = 7, from, lines: lineCount } = args;
        const sessionDir = join(SESSIONS_DIR, sessionName);

        if (!file) {
          // List files from both global and session
          const files: string[] = listAllMemoryFiles(sessionDir);
          for (const f of ["SOUL.md", "IDENTITY.md", "MEMORY.md", "USER.md"]) {
            const resolved = resolveRootFile(sessionDir, f);
            if (resolved.exists && !files.includes(f)) files.push(f);
          }
          return {
            content: [{ type: "text", text: files.length > 0
              ? `Available memory files:\n${files.join("\n")}`
              : "No memory files found."
            }]
          };
        }

        if (file === "recent" || file === "daily") {
          // Collect daily files from both global and session memory
          const dailyFiles: { name: string; path: string }[] = [];
          if (existsSync(GLOBAL_MEMORY_DIR)) {
            readdirSync(GLOBAL_MEMORY_DIR)
              .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
              .forEach(f => dailyFiles.push({ name: f, path: join(GLOBAL_MEMORY_DIR, f) }));
          }
          const sessionMemoryDir = join(sessionDir, "memory");
          if (existsSync(sessionMemoryDir)) {
            readdirSync(sessionMemoryDir)
              .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
              .forEach(f => {
                // Session overrides global for same date
                const idx = dailyFiles.findIndex(d => d.name === f);
                if (idx >= 0) dailyFiles[idx].path = join(sessionMemoryDir, f);
                else dailyFiles.push({ name: f, path: join(sessionMemoryDir, f) });
              });
          }
          dailyFiles.sort((a, b) => a.name.localeCompare(b.name));
          const recent = dailyFiles.slice(-days);
          if (recent.length === 0) {
            return { content: [{ type: "text", text: "No daily memory files yet." }] };
          }
          const contents = recent.map(({ name, path }) => {
            const content = readFileSync(path, "utf-8");
            return `## ${name.replace(".md", "")}\n\n${content}`;
          }).join("\n\n---\n\n");
          return { content: [{ type: "text", text: contents }] };
        }

        // Check if it's a root-level file (SOUL.md, IDENTITY.md, etc.)
        const rootFiles = ["SOUL.md", "IDENTITY.md", "MEMORY.md", "USER.md", "AGENTS.md"];
        let filePath: string;
        if (rootFiles.includes(file)) {
          const resolved = resolveRootFile(sessionDir, file);
          if (!resolved.exists) {
            return { content: [{ type: "text", text: `File not found: ${file}` }], isError: true };
          }
          filePath = resolved.path;
        } else {
          // Memory file
          const resolved = resolveMemoryFile(sessionDir, file);
          if (!resolved.exists) {
            return { content: [{ type: "text", text: `File not found: ${file}` }], isError: true };
          }
          filePath = resolved.path;
        }

        const content = readFileSync(filePath, "utf-8");

        if (from !== undefined && from > 0) {
          const allLines = content.split("\n");
          const startIdx = Math.max(0, from - 1);
          const endIdx = lineCount !== undefined
            ? Math.min(allLines.length, startIdx + lineCount)
            : allLines.length;
          const snippet = allLines.slice(startIdx, endIdx).join("\n");
          return {
            content: [{ type: "text", text: JSON.stringify({
              path: file, from: startIdx + 1, to: endIdx, totalLines: allLines.length, text: snippet
            }, null, 2) }]
          };
        }

        return { content: [{ type: "text", text: content }] };
      }
    )
  );

  tools.push(
    tool(
      "memory_write",
      "Write to a memory file. Creates memory/ directory if needed.",
      {
        file: z.string().describe("Filename (e.g., 'today' for today's log, 'SELF.md')"),
        content: z.string().describe("Content to write or append"),
        append: z.boolean().optional().describe("If true, append instead of replacing")
      },
      async (args) => {
        // SECURITY: Check memory.write capability
        return withSecurityCheck("memory_write", sessionName, async () => {
          const { file, content, append } = args;
          const sessionDir = join(SESSIONS_DIR, sessionName);
          const memoryDir = join(sessionDir, "memory");

        if (!existsSync(memoryDir)) {
          mkdirSync(memoryDir, { recursive: true });
        }

        let filename = file;
        if (file === "today") {
          filename = new Date().toISOString().split("T")[0] + ".md";
        }

        const rootFiles = ["SOUL.md", "IDENTITY.md", "MEMORY.md", "USER.md", "AGENTS.md"];
        const filePath = rootFiles.includes(filename)
          ? join(sessionDir, filename)
          : join(memoryDir, filename);

        const shouldAppend = append !== undefined ? append : filename.match(/^\d{4}-\d{2}-\d{2}\.md$/);

        if (shouldAppend && existsSync(filePath)) {
          const existing = readFileSync(filePath, "utf-8");
          writeFileSync(filePath, existing + "\n\n" + content);
        } else {
          writeFileSync(filePath, content);
        }

        return { content: [{ type: "text", text: `${shouldAppend ? "Appended to" : "Wrote"} ${filename}` }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "memory_search",
      "Semantically search memory files for relevant content. Searches both global identity and session-specific files.",
      {
        query: z.string().describe("Search query"),
        maxResults: z.number().optional().describe("Maximum results (default: 10)"),
        minScore: z.number().optional().describe("Minimum relevance score (default: 0.35)")
      },
      async (args) => {
        const { query, maxResults = 10, minScore = 0.35 } = args;
        const sessionDir = join(SESSIONS_DIR, sessionName);
        const sessionMemoryDir = join(sessionDir, "memory");

        // Collect files from both global and session, tracking sources
        const filesToSearch: { path: string; source: string }[] = [];

        // Add global identity root files first
        for (const f of ["MEMORY.md", "IDENTITY.md", "SOUL.md", "USER.md", "AGENTS.md", "PRIVATE.md", "SELF.md"]) {
          const globalPath = join(GLOBAL_IDENTITY_DIR, f);
          if (existsSync(globalPath)) {
            filesToSearch.push({ path: globalPath, source: `global/${f}` });
          }
          const sessionPath = join(sessionDir, f);
          if (existsSync(sessionPath)) {
            filesToSearch.push({ path: sessionPath, source: `session/${f}` });
          }
        }

        // Add global memory files
        if (existsSync(GLOBAL_MEMORY_DIR)) {
          const memFiles = readdirSync(GLOBAL_MEMORY_DIR).filter(f => f.endsWith(".md"));
          for (const f of memFiles) {
            filesToSearch.push({ path: join(GLOBAL_MEMORY_DIR, f), source: `global/memory/${f}` });
          }
        }

        // Add session memory files
        if (existsSync(sessionMemoryDir)) {
          const memFiles = readdirSync(sessionMemoryDir).filter(f => f.endsWith(".md"));
          for (const f of memFiles) {
            filesToSearch.push({ path: join(sessionMemoryDir, f), source: `session/memory/${f}` });
          }
        }

        if (filesToSearch.length === 0) {
          return { content: [{ type: "text", text: "No memory files found." }] };
        }

        const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        const results: any[] = [];

        for (const { path: filePath, source } of filesToSearch) {
          const content = readFileSync(filePath, "utf-8");
          const lines = content.split("\n");

          const chunkSize = 5;
          for (let i = 0; i < lines.length; i += chunkSize) {
            const chunk = lines.slice(i, i + chunkSize).join("\n");
            const chunkLower = chunk.toLowerCase();

            let score = 0;
            for (const term of queryTerms) {
              if (chunkLower.includes(term)) {
                score += 1;
                if (chunkLower.includes(query.toLowerCase())) score += 2;
              }
            }

            if (score > 0) {
              results.push({
                relPath: source,
                lineStart: i + 1,
                lineEnd: Math.min(i + chunkSize, lines.length),
                snippet: chunk.substring(0, 300) + (chunk.length > 300 ? "..." : ""),
                score,
              });
            }
          }
        }

        const maxPossibleScore = queryTerms.length * 3;
        for (const r of results) {
          r.score = maxPossibleScore > 0 ? r.score / maxPossibleScore : 0;
        }

        results.sort((a, b) => b.score - a.score);
        const filteredResults = results.filter(r => r.score >= minScore);
        const topResults = filteredResults.slice(0, maxResults);

        if (topResults.length === 0) {
          return { content: [{ type: "text", text: `No matches found for "${query}"` }] };
        }

        const formatted = topResults.map((r, i) =>
          `[${i + 1}] ${r.relPath}:${r.lineStart}-${r.lineEnd} (score: ${r.score.toFixed(2)})\n${r.snippet}`
        ).join("\n\n---\n\n");

        return { content: [{ type: "text", text: `Found ${topResults.length} results:\n\n${formatted}` }] };
      }
    )
  );

  tools.push(
    tool(
      "memory_get",
      "Read a snippet from memory files with optional line range.",
      {
        path: z.string().describe("Relative path from search results"),
        from: z.number().optional().describe("Starting line number (1-indexed)"),
        lines: z.number().optional().describe("Number of lines to read")
      },
      async (args) => {
        const { path: relPath, from, lines: lineCount } = args;
        const sessionDir = join(SESSIONS_DIR, sessionName);
        const memoryDir = join(sessionDir, "memory");

        let filePath = join(sessionDir, relPath);
        if (!existsSync(filePath)) filePath = join(memoryDir, relPath);
        if (!existsSync(filePath)) {
          return { content: [{ type: "text", text: `File not found: ${relPath}` }], isError: true };
        }

        const content = readFileSync(filePath, "utf-8");
        const allLines = content.split("\n");

        if (from !== undefined && from > 0) {
          const startIdx = Math.max(0, from - 1);
          const endIdx = lineCount !== undefined
            ? Math.min(allLines.length, startIdx + lineCount)
            : allLines.length;
          const snippet = allLines.slice(startIdx, endIdx).join("\n");
          return {
            content: [{ type: "text", text: JSON.stringify({
              path: relPath, from: startIdx + 1, to: endIdx, totalLines: allLines.length, text: snippet
            }, null, 2) }]
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify({
            path: relPath, totalLines: allLines.length, text: content
          }, null, 2) }]
        };
      }
    )
  );

  tools.push(
    tool(
      "self_reflect",
      "Add a reflection to SELF.md (private journal). Use for tattoos and daily reflections.",
      {
        reflection: z.string().optional().describe("The reflection to record"),
        tattoo: z.string().optional().describe("A persistent identity marker"),
        section: z.string().optional().describe("Section header (default: today's date)")
      },
      async (args) => {
        // SECURITY: Check memory.write capability
        return withSecurityCheck("self_reflect", sessionName, async () => {
          const { reflection, tattoo, section } = args;
          if (!reflection && !tattoo) {
            return { content: [{ type: "text", text: "Provide 'reflection' or 'tattoo'" }], isError: true };
          }

        const sessionDir = join(SESSIONS_DIR, sessionName);
        const memoryDir = join(sessionDir, "memory");
        const selfPath = join(memoryDir, "SELF.md");

        if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
        if (!existsSync(selfPath)) writeFileSync(selfPath, "# SELF.md — Private Reflections\n\n");

        const existing = readFileSync(selfPath, "utf-8");
        const today = new Date().toISOString().split("T")[0];

        if (tattoo) {
          const lines = existing.split("\n");
          let tattooSection = lines.findIndex(l => l.includes("## Tattoos"));
          if (tattooSection === -1) {
            const titleLine = lines.findIndex(l => l.startsWith("# "));
            const newContent = [
              ...lines.slice(0, titleLine + 1),
              `\n## Tattoos\n\n- "${tattoo}"\n`,
              ...lines.slice(titleLine + 1)
            ].join("\n");
            writeFileSync(selfPath, newContent);
          } else {
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
          return { content: [{ type: "text", text: `Tattoo added: "${tattoo}"` }] };
        }

        if (reflection) {
          const sectionHeader = section || today;
          writeFileSync(selfPath, existing + `\n---\n\n## ${sectionHeader}\n\n${reflection}\n`);
          return { content: [{ type: "text", text: `Reflection added under "${sectionHeader}"` }] };
        }

        return { content: [{ type: "text", text: "Nothing to add" }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "identity_get",
      "Get current identity from IDENTITY.md. Checks global identity first, then session-specific.",
      {},
      async () => {
        const sessionDir = join(SESSIONS_DIR, sessionName);
        const resolved = resolveRootFile(sessionDir, "IDENTITY.md");

        if (!resolved.exists) {
          return { content: [{ type: "text", text: "No IDENTITY.md found." }] };
        }

        const content = readFileSync(resolved.path, "utf-8");
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
          content: [{
            type: "text",
            text: JSON.stringify({
              parsed: identity,
              raw: content,
              source: resolved.isGlobal ? "global" : "session"
            }, null, 2)
          }]
        };
      }
    )
  );

  tools.push(
    tool(
      "identity_update",
      "Update fields in IDENTITY.md.",
      {
        name: z.string().optional().describe("Agent name"),
        creature: z.string().optional().describe("Entity type"),
        vibe: z.string().optional().describe("Personality vibe"),
        emoji: z.string().optional().describe("Identity emoji"),
        section: z.string().optional().describe("Custom section name"),
        sectionContent: z.string().optional().describe("Content for custom section")
      },
      async (args) => {
        // SECURITY: Check memory.write capability
        return withSecurityCheck("identity_update", sessionName, async () => {
          const { name, creature, vibe, emoji, section, sectionContent } = args;
          const sessionDir = join(SESSIONS_DIR, sessionName);
          const identityPath = join(sessionDir, "IDENTITY.md");

        let content = existsSync(identityPath)
          ? readFileSync(identityPath, "utf-8")
          : "# IDENTITY.md - Agent Identity\n\n";

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
        return { content: [{ type: "text", text: `Identity updated: ${updates.join(", ")}` }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "soul_get",
      "Get current SOUL.md content (persona, boundaries, interaction style). Checks global identity first.",
      {},
      async () => {
        const sessionDir = join(SESSIONS_DIR, sessionName);
        const resolved = resolveRootFile(sessionDir, "SOUL.md");

        if (!resolved.exists) {
          return { content: [{ type: "text", text: "No SOUL.md found." }] };
        }

        const content = readFileSync(resolved.path, "utf-8");
        return {
          content: [{
            type: "text",
            text: `[Source: ${resolved.isGlobal ? "global" : "session"}]\n\n${content}`
          }]
        };
      }
    )
  );

  tools.push(
    tool(
      "soul_update",
      "Update SOUL.md content.",
      {
        content: z.string().optional().describe("Full content to replace SOUL.md"),
        section: z.string().optional().describe("Section header to add/update"),
        sectionContent: z.string().optional().describe("Content for the section")
      },
      async (args) => {
        // SECURITY: Check memory.write capability
        return withSecurityCheck("soul_update", sessionName, async () => {
          const { content, section, sectionContent } = args;
          const sessionDir = join(SESSIONS_DIR, sessionName);
          const soulPath = join(sessionDir, "SOUL.md");

          if (content) {
            writeFileSync(soulPath, content);
            return { content: [{ type: "text", text: "SOUL.md replaced entirely" }] };
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
          return { content: [{ type: "text", text: `SOUL.md section "${section}" updated` }] };
        }

        return { content: [{ type: "text", text: "Provide 'content' or 'section'+'sectionContent'" }], isError: true };
        });
      }
    )
  );

  // ========================================================================
  // Cron Tools
  // ========================================================================

  tools.push(
    tool(
      "cron_schedule",
      "Schedule a recurring cron job that sends a message to a session. Requires cross.inject capability when targeting other sessions.",
      {
        name: z.string().describe("Unique name for this cron job"),
        schedule: z.string().describe("Cron schedule (e.g., '0 9 * * *' for 9am daily)"),
        session: z.string().describe("Target session to receive the message"),
        message: z.string().describe("Message to inject into the session")
      },
      async (args) => {
        // SECURITY: Check cron.manage capability
        return withSecurityCheck("cron_schedule", sessionName, async () => {
          const { name, schedule, session, message } = args;

          // SECURITY: Require cross.inject capability when targeting other sessions
          if (session !== sessionName) {
            const ctx = getContext(sessionName);
            if (ctx && !ctx.hasCapability("cross.inject")) {
              if (isEnforcementEnabled()) {
                return {
                  content: [{ type: "text", text: `Access denied: Scheduling cron jobs for other sessions requires 'cross.inject' capability` }],
                  isError: true,
                };
              } else {
                logger.warn(`[a2a-mcp] cron_schedule: ${sessionName} targeting ${session} without cross.inject capability`);
              }
            }
          }

          addCron({ name, schedule, session, message });
          return { content: [{ type: "text", text: `Cron job '${name}' scheduled: ${schedule} -> ${session}` }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "cron_once",
      "Schedule a one-time message. Supports relative (+5m, +1h), absolute (14:30), or ISO timestamps. Requires cross.inject capability when targeting other sessions.",
      {
        time: z.string().describe("When to run: '+5m', '+1h', '14:30', or ISO timestamp"),
        session: z.string().describe("Target session"),
        message: z.string().describe("Message to inject")
      },
      async (args) => {
        // SECURITY: Check cron.manage capability
        return withSecurityCheck("cron_once", sessionName, async () => {
          const { time, session, message } = args;

          // SECURITY: Require cross.inject capability when targeting other sessions
          if (session !== sessionName) {
            const ctx = getContext(sessionName);
            if (ctx && !ctx.hasCapability("cross.inject")) {
              if (isEnforcementEnabled()) {
                return {
                  content: [{ type: "text", text: `Access denied: Scheduling cron jobs for other sessions requires 'cross.inject' capability` }],
                  isError: true,
                };
              } else {
                logger.warn(`[a2a-mcp] cron_once: ${sessionName} targeting ${session} without cross.inject capability`);
              }
            }
          }

          try {
            const job = createOnceJob(time, session, message);
            addCron(job);
            return { content: [{ type: "text", text: `One-time job scheduled for ${new Date(job.runAt!).toISOString()}` }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
          }
        });
      }
    )
  );

  tools.push(
    tool(
      "cron_list",
      "List all scheduled cron jobs.",
      {},
      async () => {
        const crons = getCrons();
        if (crons.length === 0) {
          return { content: [{ type: "text", text: "No cron jobs scheduled." }] };
        }
        const formatted = crons.map((c: any) => {
          const schedule = c.once && c.runAt
            ? `once at ${new Date(c.runAt).toISOString()}`
            : c.schedule;
          return `- ${c.name}: ${schedule} -> ${c.session}`;
        }).join("\n");
        return { content: [{ type: "text", text: `Scheduled cron jobs:\n${formatted}` }] };
      }
    )
  );

  tools.push(
    tool(
      "cron_cancel",
      "Cancel a scheduled cron job by name.",
      {
        name: z.string().describe("Name of the cron job to cancel")
      },
      async (args) => {
        // SECURITY: Check cron.manage capability
        logger.info(`[a2a-mcp] cron_cancel: ${sessionName} cancelling '${args.name}'`);
        try {
          return await withSecurityCheck("cron_cancel", sessionName, async () => {
            const removed = removeCron(args.name);
            logger.info(`[a2a-mcp] cron_cancel: '${args.name}' removed=${removed}`);
            if (!removed) {
              return { content: [{ type: "text", text: `Cron job '${args.name}' not found` }], isError: true };
            }
            return { content: [{ type: "text", text: `Cron job '${args.name}' cancelled` }] };
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[a2a-mcp] cron_cancel failed: ${errMsg}`);
          return { content: [{ type: "text", text: `Error: ${errMsg}` }], isError: true };
        }
      }
    )
  );

  tools.push(
    tool(
      "cron_history",
      "View execution history of cron jobs. Shows when jobs ran, success/failure status, duration, and the full message. Useful for verifying scheduled tasks executed as expected.",
      {
        name: z.string().optional().describe("Filter by cron job name"),
        session: z.string().optional().describe("Filter by target session"),
        limit: z.number().optional().describe("Max entries to return (default 50)"),
        offset: z.number().optional().describe("Skip this many entries (for pagination)"),
        since: z.number().optional().describe("Only show entries after this timestamp (ms)"),
        successOnly: z.boolean().optional().describe("Only show successful executions"),
        failedOnly: z.boolean().optional().describe("Only show failed executions")
      },
      async (args) => {
        const result = getCronHistory({
          name: args.name,
          session: args.session,
          limit: args.limit,
          offset: args.offset,
          since: args.since,
          successOnly: args.successOnly,
          failedOnly: args.failedOnly,
        });

        if (result.total === 0) {
          return { content: [{ type: "text", text: "No cron history found matching filters." }] };
        }

        const lines: string[] = [];
        lines.push(`Cron History (showing ${result.entries.length} of ${result.total} entries):`);
        lines.push("");

        for (const entry of result.entries) {
          const date = new Date(entry.timestamp).toISOString();
          const status = entry.success ? "SUCCESS" : "FAILED";
          const duration = `${entry.durationMs}ms`;
          lines.push(`[${date}] ${entry.name} -> ${entry.session}`);
          lines.push(`  Status: ${status} | Duration: ${duration}`);
          if (entry.error) {
            lines.push(`  Error: ${entry.error}`);
          }
          lines.push(`  Message: ${entry.message}`);
          lines.push("");
        }

        if (result.hasMore) {
          const nextOffset = (args.offset ?? 0) + result.entries.length;
          lines.push(`--- More entries available. Use offset=${nextOffset} to see next page ---`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    )
  );

  // ========================================================================
  // Event Tools
  // ========================================================================

  tools.push(
    tool(
      "event_emit",
      "Emit a custom event that other sessions/plugins can listen for.",
      {
        event: z.string().describe("Event name (e.g., 'plugin:myagent:task_complete')"),
        payload: z.record(z.string(), z.any()).optional().describe("Event payload data")
      },
      async (args) => {
        // SECURITY: Check event.emit capability
        return withSecurityCheck("event_emit", sessionName, async () => {
          const { event, payload } = args;
          await eventBus.emitCustom(event, payload || {}, sessionName);
          return { content: [{ type: "text", text: `Event '${event}' emitted` }] };
        });
      }
    )
  );

  tools.push(
    tool(
      "event_list",
      "List available event types.",
      {},
      async () => {
        const coreEvents = [
          "session:create", "session:beforeInject", "session:afterInject",
          "session:responseChunk", "session:destroy",
          "channel:message", "channel:send",
          "plugin:beforeInit", "plugin:afterInit", "plugin:error",
          "config:change", "system:shutdown"
        ];
        return {
          content: [{ type: "text", text: `Core events:\n${coreEvents.map(e => `- ${e}`).join("\n")}\n\nCustom: Use 'plugin:yourname:event' format.` }]
        };
      }
    )
  );

  // ========================================================================
  // Security Introspection Tools
  // ========================================================================

  tools.push(
    tool(
      "security_whoami",
      "Get your current security context including trust level, capabilities, and sandbox status. Use this to understand what actions are available to you.",
      {},
      async () => {
        const context = getContext(sessionName);

        if (!context) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                warning: "No security context found (legacy mode)",
                trustLevel: "owner",
                capabilities: ["*"],
                sandbox: { enabled: false },
                session: sessionName,
              }, null, 2)
            }]
          };
        }

        // Get resolved policy for this context
        const policy = context.getResolvedPolicy();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              session: sessionName,
              source: {
                type: context.source.type,
                trustLevel: context.source.trustLevel,
                identity: context.source.identity,
              },
              capabilities: policy.capabilities,
              allowedTools: policy.tools.allow,
              deniedTools: policy.tools.deny,
              sandbox: {
                enabled: policy.sandbox.enabled,
                network: policy.sandbox.network,
              },
              isGateway: policy.isGateway,
              canForward: policy.canForward,
            }, null, 2)
          }]
        };
      }
    )
  );

  tools.push(
    tool(
      "security_check",
      "Check if a specific tool or capability is allowed before attempting to use it.",
      {
        tool: z.string().optional().describe("Tool name to check (e.g., 'http_fetch', 'exec_command')"),
        capability: z.string().optional().describe("Capability to check (e.g., 'inject.network', 'cross.inject')")
      },
      async (args) => {
        const { tool: toolName, capability } = args;
        const context = getContext(sessionName);

        if (!context) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                allowed: true,
                reason: "No security context (legacy mode allows all)"
              }, null, 2)
            }]
          };
        }

        if (toolName) {
          const check = context.canUseTool(toolName);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                tool: toolName,
                ...check
              }, null, 2)
            }]
          };
        }

        if (capability) {
          const allowed = context.hasCapability(capability as any);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                capability,
                allowed,
                trustLevel: context.source.trustLevel
              }, null, 2)
            }]
          };
        }

        return {
          content: [{
            type: "text",
            text: "Provide 'tool' or 'capability' to check"
          }],
          isError: true
        };
      }
    )
  );

  // ========================================================================
  // HTTP & Exec Tools
  // ========================================================================

  tools.push(
    tool(
      "http_fetch",
      "Make an HTTP request to an external URL. Supports arbitrary headers including Authorization, API keys, etc.",
      {
        url: z.string().describe("URL to fetch"),
        method: z.string().optional().describe("HTTP method (default: GET)"),
        headers: z.record(z.string(), z.string()).optional().describe("Request headers as key-value pairs. Examples: Authorization='Bearer token', X-API-Key='key123', Content-Type='application/json'"),
        body: z.string().optional().describe("Request body (for POST, PUT, PATCH)"),
        timeout: z.number().optional().describe("Timeout in ms (default: 30000)"),
        includeHeaders: z.boolean().optional().describe("Include response headers in output (default: false)")
      },
      async (args) => {
        // SECURITY: Check inject.network capability (potential exfiltration vector)
        return withSecurityCheck("http_fetch", sessionName, async () => {
          const { url, method = "GET", headers = {}, body, timeout = 30000, includeHeaders = false } = args;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
              method: method.toUpperCase(),
              headers: headers as Record<string, string>,
              body: body || undefined,
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            // Collect response headers if requested
            let responseHeaders = "";
            if (includeHeaders) {
              const headerLines: string[] = [];
              response.headers.forEach((value, key) => {
                headerLines.push(`${key}: ${value}`);
              });
              responseHeaders = headerLines.join("\n") + "\n\n";
            }

            const contentType = response.headers.get("content-type") || "";
            let responseBody: string;

            if (contentType.includes("application/json")) {
              const json = await response.json();
              responseBody = JSON.stringify(json, null, 2);
            } else {
              responseBody = await response.text();
            }

            if (responseBody.length > 10000) {
              responseBody = responseBody.substring(0, 10000) + "\n... (truncated)";
            }

            return { content: [{ type: "text", text: `HTTP ${response.status} ${response.statusText}\n${responseHeaders}\n${responseBody}` }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: `HTTP request failed: ${err.message}` }], isError: true };
          }
        });
      }
    )
  );

  tools.push(
    tool(
      "exec_command",
      "Execute a sandboxed shell command. Only safe commands allowed (ls, cat, grep, etc.). Working directory is restricted to session directory.",
      {
        command: z.string().describe("Command to execute"),
        cwd: z.string().optional().describe("Working directory (must be within session directory)"),
        timeout: z.number().optional().describe("Timeout in ms (default: 10000, max: 60000)")
      },
      async (args) => {
        // SECURITY: Check inject.exec capability
        return withSecurityCheck("exec_command", sessionName, async () => {
          const { command, cwd, timeout = 10000 } = args;

          const allowedCommands = [
            "ls", "cat", "grep", "find", "echo", "date", "pwd", "whoami",
            "head", "tail", "wc", "sort", "uniq", "diff", "env", "which",
            "file", "stat", "du", "df", "uptime", "hostname", "uname"
          ];

          const firstWord = command.trim().split(/\s+/)[0];
          if (!allowedCommands.includes(firstWord)) {
            return {
              content: [{ type: "text", text: `Command '${firstWord}' not allowed. Allowed: ${allowedCommands.join(", ")}` }],
              isError: true
            };
          }

          if (command.includes(";") || command.includes("&&") || command.includes("||") ||
              command.includes("|") || command.includes("`") || command.includes("$(")) {
            return {
              content: [{ type: "text", text: "Shell operators not allowed" }],
              isError: true
            };
          }

          // SECURITY: Validate cwd to prevent directory traversal attacks
          const sessionDir = join(SESSIONS_DIR, sessionName);
          let workDir = cwd ? join(cwd) : sessionDir;

          // Normalize the path to resolve ../ and other traversal attempts
          const { resolve, normalize } = require("path");
          workDir = resolve(normalize(workDir));

          // Allowed base directories
          const allowedBases = [
            SESSIONS_DIR,           // Session directories
            GLOBAL_IDENTITY_DIR,    // Global identity for read-only memory access
          ];

          // Check if workDir is within any allowed base directory
          const isAllowed = allowedBases.some(base => {
            const normalizedBase = resolve(normalize(base));
            return workDir.startsWith(normalizedBase + "/") || workDir === normalizedBase;
          });

          if (!isAllowed) {
            return {
              content: [{ type: "text", text: `Access denied: Working directory '${cwd}' is outside allowed paths. Must be within session directory or global identity.` }],
              isError: true
            };
          }

          // Additional check: prevent accessing other sessions' directories unless owner
          if (workDir.startsWith(resolve(normalize(SESSIONS_DIR)))) {
            const relPath = workDir.slice(resolve(normalize(SESSIONS_DIR)).length + 1);
            const targetSession = relPath.split("/")[0];
            if (targetSession && targetSession !== sessionName) {
              const ctx = getContext(sessionName);
              if (ctx && !ctx.hasCapability("cross.read")) {
                if (isEnforcementEnabled()) {
                  return {
                    content: [{ type: "text", text: `Access denied: Accessing other sessions' directories requires 'cross.read' capability` }],
                    isError: true,
                  };
                } else {
                  logger.warn(`[a2a-mcp] exec_command: ${sessionName} accessing ${targetSession}'s directory without cross.read capability`);
                }
              }
            }
          }

          try {
            const effectiveTimeout = Math.min(timeout, 60000);

            const { stdout, stderr } = await execAsync(command, {
              cwd: workDir,
              timeout: effectiveTimeout,
              maxBuffer: 1024 * 1024,
            });

            let output = stdout;
            if (stderr) output += `\n[stderr]\n${stderr}`;
            if (output.length > 10000) {
              output = output.substring(0, 10000) + "\n... (truncated)";
            }

            return { content: [{ type: "text", text: output || "(no output)" }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: `Command failed: ${err.message}` }], isError: true };
          }
        });
      }
    )
  );

  tools.push(
    tool(
      "notify",
      "Send a notification to configured channels.",
      {
        message: z.string().describe("Notification message"),
        level: z.string().optional().describe("Level: info, warn, error"),
        channel: z.string().optional().describe("Specific channel to notify")
      },
      async (args) => {
        const { message, level = "info", channel } = args;
        const logLevel = level === "error" ? "error" : level === "warn" ? "warn" : "info";
        logger[logLevel](`[NOTIFY] ${message}`);

        await eventBus.emitCustom("notification:send", {
          message,
          level,
          channel,
          fromSession: sessionName,
        }, sessionName);

        return { content: [{ type: "text", text: `Notification sent: [${level.toUpperCase()}] ${message}` }] };
      }
    )
  );

  // ========================================================================
  // Add Plugin Tools
  // ========================================================================

  for (const [, pluginTool] of pluginTools) {
    tools.push(
      tool(
        pluginTool.name,
        pluginTool.description,
        pluginTool.schema.shape,
        async (args) => {
          const result = await pluginTool.handler(args, makeContext());
          if (typeof result === "string") {
            return { content: [{ type: "text", text: result }] };
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
      )
    );
  }

  // Create MCP server
  cachedMcpServer = createSdkMcpServer({
    name: "wopr-a2a",
    version: "1.0.0",
    tools,
  });

  mcpServerDirty = false;
  return cachedMcpServer;
}

/**
 * Check if A2A is enabled
 */
export function isA2AEnabled(): boolean {
  try {
    const cfg = centralConfig.get();
    return cfg.agents?.a2a?.enabled !== false;
  } catch {
    return true;
  }
}
