import { logger } from "../logger.js";
/**
 * Core session management and injection with provider routing
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";
import { SESSIONS_DIR, SESSIONS_FILE } from "../paths.js";
import type { StreamCallback, StreamMessage, ConversationEntry, ChannelRef } from "../types.js";
import type { ProviderConfig } from "../types/provider.js";
import {
  applyIncomingMiddlewares,
  applyOutgoingMiddlewares,
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
  emitSessionBeforeInject,
  emitSessionAfterInject,
  emitSessionResponseChunk,
  emitSessionCreate,
  emitSessionDestroy,
} from "./events.js";

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

  // Emit beforeInject event (plugins can modify behavior here)
  await emitSessionBeforeInject(name, messageText, from, channel ? { 
    type: channel.type, 
    id: channel.id, 
    name: channel.name 
  } : undefined);

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

  // Log incoming message to conversation log
  const middlewareMessage = await applyIncomingMiddlewares({
    session: name,
    from,
    message: messageText,
    channel,
  });

  if (middlewareMessage === null) {
    appendToConversationLog(name, {
      ts: Date.now(),
      from: "system",
      content: "Message blocked by middleware.",
      type: "middleware",
      channel,
    });
    return { response: "", sessionId, cost: 0 };
  }

  appendToConversationLog(name, {
    ts: Date.now(),
    from,
    content: middlewareMessage + (messageImages.length > 0 ? `\n[Images: ${messageImages.join(', ')}]` : ''),
    type: "message",
    channel,
  });

  // Build full message (context + user message)
  // Context from providers goes before the actual message for conversation flow
  const fullMessage = assembled.context 
    ? `${assembled.context}\n\n${middlewareMessage}` 
    : middlewareMessage;
  
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

  const middlewareResponse = await applyOutgoingMiddlewares({
    session: name,
    from,
    response,
    channel,
  });

  if (middlewareResponse === null) {
    appendToConversationLog(name, {
      ts: Date.now(),
      from: "system",
      content: "Response blocked by middleware.",
      type: "middleware",
      channel,
    });
    return { response: "", sessionId, cost };
  }

  response = middlewareResponse;

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

  // Emit new event bus event for afterInject
  await emitSessionAfterInject(name, messageText, response, from);

  // Update last trigger timestamp for progressive context
  // This marks the end of this interaction, so next trigger gets context since now
  const { updateLastTriggerTimestamp } = await import("./context.js");
  updateLastTriggerTimestamp(name);

  return { response, sessionId, cost };
}

