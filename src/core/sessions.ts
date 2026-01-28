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
  getChannel,
  getContextProvider,
} from "../plugins.js";
import { discoverSkills, formatSkillsXml } from "./skills.js";
import { providerRegistry } from "./providers.js";

// Ensure directories exist
if (!existsSync(SESSIONS_DIR)) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
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

export function deleteSession(name: string): void {
  deleteSessionId(name);
  const contextFile = join(SESSIONS_DIR, `${name}.md`);
  if (existsSync(contextFile)) unlinkSync(contextFile);
  const providerFile = join(SESSIONS_DIR, `${name}.provider.json`);
  if (existsSync(providerFile)) unlinkSync(providerFile);
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
}

export interface InjectResult {
  response: string;
  sessionId: string;
  cost: number;
}

export async function inject(
  name: string,
  message: string,
  options?: InjectOptions
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

  if (!silent) {
    console.log(`[wopr] Injecting into session: ${name}`);
    if (existingSessionId) {
      console.log(`[wopr] Resuming session: ${existingSessionId}`);
    } else {
      console.log(`[wopr] Creating new session`);
    }
  }

  let conversationContext = "";
  const channelAdapter = channel ? getChannel(channel) : undefined;
  const contextProvider = channelAdapter ? undefined : getContextProvider(name);

  try {
    if (channelAdapter) {
      conversationContext = await channelAdapter.getContext();
      if (!silent && conversationContext) {
        console.log(`[wopr] Channel context added conversation history`);
      }
    } else if (contextProvider) {
      conversationContext = await contextProvider.getContext(name);
      if (!silent && conversationContext) {
        console.log(`[wopr] Context provider added conversation history`);
      }
    }

    if (conversationContext) {
      appendToConversationLog(name, {
        ts: Date.now(),
        from: "system",
        content: conversationContext,
        type: "context",
        channel,
      });
    }
  } catch (err: any) {
    console.error(`[wopr] Context provider error: ${err.message}`);
  }

  // Log incoming message to conversation log
  const middlewareMessage = await applyIncomingMiddlewares({
    session: name,
    from,
    message,
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
    content: middlewareMessage,
    type: "message",
    channel,
  });

  // Prepend conversation context to message
  const fullMessage = conversationContext ? `${conversationContext}${middlewareMessage}` : middlewareMessage;

  const skills = discoverSkills();
  const skillsXml = formatSkillsXml(skills);
  const baseContext = context || `You are WOPR session "${name}".`;
  const fullContext = skillsXml ? `${baseContext}\n${skillsXml}` : baseContext;

  // Load provider config from session or use defaults
  let providerConfig = getSessionProvider(name);
  if (!providerConfig) {
    // Default: anthropic with fallback to codex
    providerConfig = {
      name: "anthropic",
      fallback: ["codex"],
    };
  }

  let resolvedProvider: any = null;
  let providerUsed = "unknown";

  try {
    // Resolve provider with fallback chain
    resolvedProvider = await providerRegistry.resolveProvider(providerConfig);
    providerUsed = resolvedProvider.name;
    if (!silent) console.log(`[wopr] Using provider: ${providerUsed}`);
  } catch (err) {
    // If provider resolution fails, try fallback to Anthropic SDK directly
    if (!silent) console.error(`[wopr] Provider resolution failed: ${err}`);
    if (!silent) console.log(`[wopr] Falling back to direct Anthropic query`);
    resolvedProvider = null;
  }

  // Execute query using resolved provider or fallback to direct query
  let q: any;
  if (resolvedProvider) {
    // Use provider registry to execute query
    q = resolvedProvider.client.query({
      prompt: fullMessage,
      systemPrompt: fullContext,
      resume: existingSessionId,
      model: resolvedProvider.provider.defaultModel,
    });
  } else {
    // Fallback: use hardcoded Anthropic query
    q = query({
      prompt: fullMessage,
      options: {
        resume: existingSessionId,
        systemPrompt: fullContext,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      }
    });
  }

  for await (const msg of q) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          sessionId = msg.session_id;
          saveSessionId(name, sessionId);
          if (!silent) console.log(`[wopr] Session ID: ${sessionId}`);
        }
        break;
      case "assistant":
        for (const block of msg.message.content) {
          if (block.type === "text") {
            collected.push(block.text);
            if (!silent) console.log(block.text);
            const streamMsg: StreamMessage = { type: "text", content: block.text };
            if (onStream) onStream(streamMsg);
            emitStream(name, from, streamMsg);
          } else if (block.type === "tool_use") {
            if (!silent) console.log(`[tool] ${block.name}`);
            const streamMsg: StreamMessage = { type: "tool_use", content: "", toolName: block.name };
            if (onStream) onStream(streamMsg);
            emitStream(name, from, streamMsg);
          }
        }
        break;
      case "result":
        if (msg.subtype === "success") {
          cost = msg.total_cost_usd;
          if (!silent) console.log(`\n[wopr] Complete (${providerUsed}). Cost: $${cost.toFixed(4)}`);
          const streamMsg: StreamMessage = { type: "complete", content: `Cost: $${cost.toFixed(4)}` };
          if (onStream) onStream(streamMsg);
          emitStream(name, from, streamMsg);
        } else {
          if (!silent) console.error(`[wopr] Error: ${msg.subtype}`);
          const streamMsg: StreamMessage = { type: "error", content: msg.subtype };
          if (onStream) onStream(streamMsg);
          emitStream(name, from, streamMsg);
        }
        break;
    }
  }

  let response = collected.join("\n");

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
  emitInjection(name, from, message, response);

  return { response, sessionId, cost };
}

