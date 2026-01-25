/**
 * Sessions API routes
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  getSessions,
  listSessions,
  getSessionContext,
  setSessionContext,
  deleteSession,
  inject,
  readConversationLog
} from "../../core/sessions.js";
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
sessionsRouter.delete("/:name", (c) => {
  const name = c.req.param("name");
  deleteSession(name);
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
