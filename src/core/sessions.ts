import { logger } from "../logger.js";
/**
 * Core session management and injection with provider routing
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, appendFileSync, readdirSync } from "fs";
import { join } from "path";
import { SESSIONS_DIR, SESSIONS_FILE } from "../paths.js";
import type { StreamCallback, StreamMessage, ConversationEntry, ChannelRef, InjectionSource } from "../types.js";
import type { ProviderConfig } from "../types/provider.js";
import {
  SecurityContext,
  createSecurityContext,
  createCliContext,
  createInjectionSource,
  checkSessionAccess,
  isEnforcementEnabled,
  storeContext,
  clearContext,
} from "../security/index.js";
import {
  emitInjection,
  emitStream,
} from "../plugins.js";
import { providerRegistry } from "./providers.js";
import {
  assembleContext,
  initContextSystem,
  type MessageInfo,
  type AssembledContext
} from "./context.js";
import {
  emitMutableIncoming,
  emitMutableOutgoing,
  emitSessionResponseChunk,
  emitSessionCreate,
  emitSessionDestroy,
} from "./events.js";
import {
  getA2AMcpServer,
  setSessionFunctions,
  isA2AEnabled,
} from "./a2a-mcp.js";

// Re-export A2A tool registration for plugins
export {
  registerA2ATool,
  unregisterA2ATool,
  listA2ATools,
  type ToolContext,
} from "./a2a-mcp.js";

// Initialize context system with defaults (async)
const contextInitPromise = initContextSystem();
// Don't block - let it initialize in background

// Export functions for A2A MCP server (deferred to avoid circular imports)
// This is called after module initialization
let sessionFunctionsInitialized = false;
function initSessionFunctions(): void {
  if (sessionFunctionsInitialized) return;
  sessionFunctionsInitialized = true;
  setSessionFunctions({
    inject,
    getSessions,
    readConversationLog,
    setSessionContext,
  });
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
  /**
   * Security source for this injection.
   * If not provided, defaults to CLI source (owner trust level).
   * Plugins and P2P should always provide this for proper security enforcement.
   */
  source?: InjectionSource;
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

  // SECURITY: Create security context from source (defaults to CLI/owner)
  const injectionSource = options?.source ?? createInjectionSource("cli");
  const securityContext = createSecurityContext(injectionSource, name);

  // Store security context for this session (accessible during request)
  storeContext(securityContext);

  try {
    // SECURITY: Check session access
    const accessCheck = checkSessionAccess(injectionSource, name);
    if (!accessCheck.allowed) {
      if (isEnforcementEnabled()) {
        securityContext.recordEvent("access_denied", {
          allowed: false,
          reason: accessCheck.reason,
        });
        throw new Error(`Access denied: ${accessCheck.reason}`);
      } else {
        // Warn mode - log but continue
        logger.warn(`[security] ${securityContext.requestId}: Access would be denied - ${accessCheck.reason}`);
      }
    } else {
      securityContext.recordEvent("access_granted", {
        allowed: true,
      });
    }

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
    if (available.length > 0) {
      providerConfig = {
        name: available[0].id,
      };
      // Save this provider config for the session
      setSessionProvider(name, providerConfig);
    }
    // If no providers available, will fall back to direct Anthropic SDK query
  }

  let resolvedProvider: any = null;
  let providerUsed = "anthropic-sdk";

  if (providerConfig) {
    try {
      // Resolve provider with fallback chain
      resolvedProvider = await providerRegistry.resolveProvider(providerConfig);
      providerUsed = resolvedProvider.name;
      if (!silent) logger.info(`[wopr] Using provider: ${providerUsed}`);
    } catch (err) {
      // If provider resolution fails, try fallback to Anthropic SDK directly
      if (!silent) logger.error(`[wopr] Provider resolution failed: ${err}`);
      if (!silent) logger.info(`[wopr] Falling back to direct Anthropic SDK query`);
      resolvedProvider = null;
    }
  } else {
    // No provider configured, use direct Anthropic SDK with OAuth
    if (!silent) logger.info(`[wopr] No providers configured, using direct Anthropic SDK with OAuth`);
  }

  // Execute query using resolved provider or fallback to direct query
  // Initialize session functions for the MCP server (deferred to avoid circular imports)
  initSessionFunctions();

  // Get A2A MCP server if enabled
  const a2aMcpServer = isA2AEnabled() ? getA2AMcpServer(name) : null;
  const mcpServers = a2aMcpServer ? { "wopr-a2a": a2aMcpServer } : undefined;

  // Helper to create query with optional session resume
  const createQuery = (resumeSessionId?: string) => {
    if (resolvedProvider) {
      // Use provider registry to execute query
      return resolvedProvider.client.query({
        prompt: fullMessage,
        systemPrompt: fullContext,
        resume: resumeSessionId,
        model: providerConfig?.model || resolvedProvider.provider.defaultModel,
        images: messageImages.length > 0 ? messageImages : undefined,
        mcpServers,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      });
    } else {
      // Fallback: use direct Anthropic SDK query
      const fallbackOptions: any = {
        systemPrompt: fullContext,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      };
      if (resumeSessionId) {
        fallbackOptions.resume = resumeSessionId;
      }
      if (mcpServers) {
        fallbackOptions.mcpServers = mcpServers;
      }
      // Use session model if configured
      if (providerConfig?.model) {
        fallbackOptions.model = providerConfig.model;
        logger.info(`[wopr] Using session model: ${providerConfig.model}`);
      }
      return query({
        prompt: fullMessage,
        options: fallbackOptions,
      });
    }
  };

  let q: any = createQuery(existingSessionId);
  let sessionResumeRetried = false;

  try {
  for await (const msg of q) {
    // Check for cancellation
    if (abortSignal?.aborted) {
      logger.info(`[wopr] Inject cancelled mid-stream for session: ${name}`);
      throw new Error("Inject cancelled");
    }

    logger.info(`[inject] Got msg type: ${msg.type}, subtype: ${msg.subtype || 'none'}, keys: ${Object.keys(msg).join(',')}`);
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
            // MCP server handles tool execution automatically
            // We just log and stream the tool use for visibility
            if (!silent) logger.info(`[tool] ${block.name}`);
            const streamMsg: StreamMessage = { type: "tool_use", content: "", toolName: block.name };
            if (onStream) onStream(streamMsg);
            emitStream(name, from, streamMsg);
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
          if (msg.errors) {
            logger.error(`[wopr] Error details: ${JSON.stringify(msg.errors)}`);
          }
          if (msg.permission_denials) {
            logger.error(`[wopr] Permission denials: ${JSON.stringify(msg.permission_denials)}`);
          }
          const streamMsg: StreamMessage = { type: "error", content: msg.subtype };
          if (onStream) onStream(streamMsg);
          emitStream(name, from, streamMsg);
        }
        break;
    }
  }
  } catch (sdkError: any) {
    // Check if this is a "No conversation found" error from trying to resume a stale session
    const errorMsg = sdkError.message || '';
    if (!sessionResumeRetried && existingSessionId && errorMsg.includes('process exited with code 1')) {
      // The session might be stale - clear it and retry without resume
      logger.warn(`[wopr] Session resume may have failed, clearing session ID and retrying...`);
      deleteSessionId(name);
      sessionResumeRetried = true;

      // Create new query without resume
      q = createQuery(undefined);

      // Re-iterate with new query
      for await (const msg of q) {
        if (abortSignal?.aborted) {
          throw new Error("Inject cancelled");
        }

        logger.info(`[inject] Retry msg type: ${msg.type}, subtype: ${msg.subtype || 'none'}`);
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") {
              sessionId = msg.session_id;
              saveSessionId(name, sessionId);
              if (!silent) logger.info(`[wopr] New session ID: ${sessionId}`);
            }
            break;
          case "assistant":
            for (const block of msg.message.content) {
              if (block.type === "text") {
                collected.push(block.text);
                if (!silent) logger.info(block.text);
                const streamMsg: StreamMessage = { type: "text", content: block.text };
                if (onStream) onStream(streamMsg);
                emitStream(name, from, streamMsg);
              } else if (block.type === "tool_use") {
                if (!silent) logger.info(`[tool] ${block.name}`);
                const streamMsg: StreamMessage = { type: "tool_use", content: "", toolName: block.name };
                if (onStream) onStream(streamMsg);
                emitStream(name, from, streamMsg);
              }
            }
            break;
          case "result":
            if (msg.subtype === "success") {
              cost = msg.total_cost_usd;
              if (!silent) logger.info(`[wopr] Complete (retry). Cost: $${cost.toFixed(4)}`);
            }
            break;
        }
      }
    } else {
      logger.error(`[wopr] SDK error during query iteration: ${sdkError.message}`);
      if (sdkError.stack) {
        logger.error(`[wopr] SDK error stack: ${sdkError.stack}`);
      }
      throw sdkError;
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
  } finally {
    // SECURITY: Always clear context when request completes
    clearContext(name);
  }
}

