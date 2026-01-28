/**
 * Middleware and Context Provider API routes
 */

import { Hono } from "hono";
import {
  getMiddlewares,
  getMiddlewareChain,
  messageMiddlewares,
} from "../../plugins.js";
import {
  getRegisteredProviders,
  contextProviders,
} from "../../core/context.js";

export const middlewareRouter = new Hono();

// ============================================================================
// Middleware Routes
// ============================================================================

// List all middleware with full details
middlewareRouter.get("/", (c) => {
  const middlewares = getMiddlewares();
  return c.json({
    middlewares: middlewares.map(m => ({
      name: m.name,
      priority: m.priority ?? 100,
      enabled: m.enabled !== false,
      hasIncoming: !!m.onIncoming,
      hasOutgoing: !!m.onOutgoing,
    })),
  });
});

// Get middleware chain execution order
middlewareRouter.get("/chain", (c) => {
  const chain = getMiddlewareChain();
  return c.json({ chain });
});

// Get specific middleware details
middlewareRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  const middleware = messageMiddlewares.get(name);
  
  if (!middleware) {
    return c.json({ error: "Middleware not found" }, 404);
  }
  
  return c.json({
    name: middleware.name,
    priority: middleware.priority ?? 100,
    enabled: middleware.enabled !== false,
    hasIncoming: !!middleware.onIncoming,
    hasOutgoing: !!middleware.onOutgoing,
  });
});

// Enable/disable middleware at runtime
middlewareRouter.post("/:name/enable", (c) => {
  const name = c.req.param("name");
  const middleware = messageMiddlewares.get(name);
  
  if (!middleware) {
    return c.json({ error: "Middleware not found" }, 404);
  }
  
  // Note: This is a runtime-only change, not persisted
  middleware.enabled = true;
  return c.json({ enabled: true, name });
});

middlewareRouter.post("/:name/disable", (c) => {
  const name = c.req.param("name");
  const middleware = messageMiddlewares.get(name);
  
  if (!middleware) {
    return c.json({ error: "Middleware not found" }, 404);
  }
  
  // Note: This is a runtime-only change, not persisted
  middleware.enabled = false;
  return c.json({ disabled: true, name });
});

// Update middleware priority
middlewareRouter.put("/:name/priority", async (c) => {
  const name = c.req.param("name");
  const middleware = messageMiddlewares.get(name);
  
  if (!middleware) {
    return c.json({ error: "Middleware not found" }, 404);
  }
  
  const body = await c.req.json();
  const priority = body.priority;
  
  if (typeof priority !== "number") {
    return c.json({ error: "priority must be a number" }, 400);
  }
  
  middleware.priority = priority;
  return c.json({ name, priority });
});

// ============================================================================
// Context Provider Routes
// ============================================================================

// List all context providers
middlewareRouter.get("/context", (c) => {
  const providers = getRegisteredProviders();
  return c.json({
    providers: providers.map(p => ({
      name: p.name,
      priority: p.priority,
      enabled: p.enabled !== false,
    })),
  });
});

// Get specific context provider
middlewareRouter.get("/context/:name", (c) => {
  const name = c.req.param("name");
  const provider = contextProviders.get(name);
  
  if (!provider) {
    return c.json({ error: "Context provider not found" }, 404);
  }
  
  return c.json({
    name: provider.name,
    priority: provider.priority,
    enabled: provider.enabled !== false,
  });
});

// Enable/disable context provider at runtime
middlewareRouter.post("/context/:name/enable", (c) => {
  const name = c.req.param("name");
  const provider = contextProviders.get(name);
  
  if (!provider) {
    return c.json({ error: "Context provider not found" }, 404);
  }
  
  provider.enabled = true;
  return c.json({ enabled: true, name });
});

middlewareRouter.post("/context/:name/disable", (c) => {
  const name = c.req.param("name");
  const provider = contextProviders.get(name);
  
  if (!provider) {
    return c.json({ error: "Context provider not found" }, 404);
  }
  
  provider.enabled = false;
  return c.json({ disabled: true, name });
});

// Update context provider priority
middlewareRouter.put("/context/:name/priority", async (c) => {
  const name = c.req.param("name");
  const provider = contextProviders.get(name);
  
  if (!provider) {
    return c.json({ error: "Context provider not found" }, 404);
  }
  
  const body = await c.req.json();
  const priority = body.priority;
  
  if (typeof priority !== "number") {
    return c.json({ error: "priority must be a number" }, 400);
  }
  
  provider.priority = priority;
  return c.json({ name, priority });
});
