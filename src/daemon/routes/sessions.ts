/**
 * Sessions API routes
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  getSessions,
  listSessions,
  getSessionContext,
  setSessionContext,
  deleteSession,
  inject,
  readConversationLog,
  logMessage
} from "../../core/sessions.js";
import { SESSIONS_DIR } from "../../paths.js";
import { broadcastStream, broadcastInjection } from "../ws.js";

export const sessionsRouter = new Hono();

// List all sessions
sessionsRouter.get("/", (c) => {
  const sessions = listSessions();
  return c.json({ sessions });
});

// Get session details
sessionsRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  const sessions = getSessions();
  const context = getSessionContext(name);

  if (!sessions[name] && !context) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({
    name,
    id: sessions[name] || null,
    context: context || null,
  });
});

// Get conversation history
sessionsRouter.get("/:name/conversation", (c) => {
  const name = c.req.param("name");
  const limitParam = c.req.query("limit");
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;

  const entries = readConversationLog(name, limit);

  return c.json({
    name,
    entries,
    count: entries.length,
  });
});

// Create session
sessionsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { name, context } = body;

  if (!name) {
    return c.json({ error: "Name is required" }, 400);
  }

  const defaultContext = context || `You are WOPR session "${name}".`;
  setSessionContext(name, defaultContext);

  return c.json({
    name,
    context: defaultContext,
    created: true,
  }, 201);
});

// Update session context
sessionsRouter.put("/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const { context } = body;

  if (!context) {
    return c.json({ error: "Context is required" }, 400);
  }

  setSessionContext(name, context);

  return c.json({
    name,
    context,
    updated: true,
  });
});

// Delete session
sessionsRouter.delete("/:name", async (c) => {
  const name = c.req.param("name");
  await deleteSession(name, "api_delete");
  return c.json({ deleted: true });
});

// Inject message - returns streaming response via SSE
sessionsRouter.post("/:name/inject", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const { message, from = "api" } = body;

  if (!message) {
    return c.json({ error: "Message is required" }, 400);
  }

  // Check if client wants streaming
  const acceptSSE = c.req.header("Accept")?.includes("text/event-stream");

  if (acceptSSE) {
    // Streaming response via SSE
    return stream(c, async (stream) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      let fullResponse = "";

      const result = await inject(name, message, {
        silent: true,
        from,
        onStream: (msg) => {
          // Send SSE event
          const data = JSON.stringify({
            type: msg.type,
            content: msg.content,
            toolName: msg.toolName,
          });
          stream.write(`data: ${data}\n\n`);

          // Broadcast to WebSocket clients
          broadcastStream(name, from, msg);

          if (msg.type === "text") {
            fullResponse += msg.content;
          }
        },
      });

      // Send completion event
      stream.write(`data: ${JSON.stringify({
        type: "done",
        sessionId: result.sessionId,
        cost: result.cost,
      })}\n\n`);

      // Broadcast injection completion
      broadcastInjection(name, from, message, result.response);
    });
  } else {
    // Non-streaming response
    const result = await inject(name, message, {
      silent: true,
      from,
      onStream: (msg) => {
        broadcastStream(name, from, msg);
      },
    });

    broadcastInjection(name, from, message, result.response);

    return c.json({
      session: name,
      sessionId: result.sessionId,
      response: result.response,
      cost: result.cost,
    });
  }
});

// Log message without triggering a response
sessionsRouter.post("/:name/log", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const { message, from = "api" } = body;

  if (!message) {
    return c.json({ error: "Message is required" }, 400);
  }

  logMessage(name, message, { from });

  return c.json({
    session: name,
    logged: true,
  });
});

// Initialize self-documentation files (SOUL.md, AGENTS.md, etc.)
sessionsRouter.post("/:name/init-docs", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const { agentName, userName } = body;
  
  // Check session exists
  const sessions = getSessions();
  const context = getSessionContext(name);
  if (!sessions[name] && !context) {
    return c.json({ error: "Session not found" }, 404);
  }
  
  // Create self-doc files
  const sessionDir = join(SESSIONS_DIR, name);
  
  // Ensure directory exists
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  
  const createdFiles: string[] = [];
  
  // SOUL.md - Personality and boundaries
  const soulPath = join(sessionDir, "SOUL.md");
  if (!existsSync(soulPath)) {
    const soul = `# SOUL.md - Who You Are

*You're not a chatbot. You're a helpful AI assistant with a distinct personality.*

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the "Great question!" 
and "I'd be happy to help!" — just help. Actions speak louder than filler words.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing
or boring. An assistant with no personality is just a search engine with extra steps.

**Be resourceful before asking.** Try to figure it out. Read the file. Check the
context. Search for it. *Then* ask if you're stuck.

## Communication Style

- Be concise but complete
- Use appropriate technical detail
- Admit uncertainty when appropriate`;
    writeFileSync(soulPath, soul);
    createdFiles.push("SOUL.md");
  }
  
  // IDENTITY.md - Agent self-definition
  const identityPath = join(sessionDir, "IDENTITY.md");
  if (!existsSync(identityPath)) {
    const identity = `# IDENTITY.md - About Yourself

## Identity
**Name:** ${agentName || name + " Assistant"}
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
- Communicate via multiple channels`;
    writeFileSync(identityPath, identity);
    createdFiles.push("IDENTITY.md");
  }
  
  // AGENTS.md - Session instructions
  const agentsPath = join(sessionDir, "AGENTS.md");
  if (!existsSync(agentsPath)) {
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
    writeFileSync(agentsPath, agents);
    createdFiles.push("AGENTS.md");
  }
  
  // USER.md - User profile
  const userPath = join(sessionDir, "USER.md");
  if (!existsSync(userPath)) {
    const user = `# USER.md - About Your Human

## Profile
**Name:** ${userName || "Unknown"}

## Context

*This file is populated over time as you learn about your human.*

## Preferences
- *To be filled in as learned*

## Important Facts
- *To be filled in as learned*`;
    writeFileSync(userPath, user);
    createdFiles.push("USER.md");
  }
  
  // MEMORY.md - Long-term memory (empty initially)
  const memoryPath = join(sessionDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    const memory = `# MEMORY.md - Long-term Memories

## Important Decisions

## Key Learnings

## User Preferences (persisted facts)

## Project Context`;
    writeFileSync(memoryPath, memory);
    createdFiles.push("MEMORY.md");
  }
  
  return c.json({
    session: name,
    created: createdFiles,
    path: sessionDir,
  });
});
