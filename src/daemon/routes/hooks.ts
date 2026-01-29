/**
 * Hooks and Context Provider API routes
 */

import { Hono } from "hono";
import {
  getRegisteredProviders,
  contextProviders,
} from "../../core/context.js";
import { getLoadedPlugin } from "../../plugins.js";

export const hooksRouter = new Hono();

// ============================================================================
// Hooks Routes
// ============================================================================

// List all hooks from all loaded plugins
hooksRouter.get("/", (c) => {
  // Collect hooks from all loaded plugins
  // Since hooks are registered per-plugin via the hook manager,
  // we need to aggregate them
  // For now, return an empty list - plugins manage their own hooks
  return c.json({
    message: "Hooks are managed per-plugin via ctx.hooks.on(). Use /hooks/list/:plugin to see hooks for a specific plugin.",
    note: "Hooks replace the middleware system with priority-ordered event handlers.",
  });
});

// List hooks for a specific plugin (if it exposes them)
hooksRouter.get("/list/:plugin", (c) => {
  const pluginName = c.req.param("plugin");
  const loaded = getLoadedPlugin(pluginName);

  if (!loaded) {
    return c.json({ error: "Plugin not found or not loaded" }, 404);
  }

  // The hook manager has a list() method
  const hooks = loaded.context.hooks.list();
  return c.json({ plugin: pluginName, hooks });
});

// ============================================================================
// Context Provider Routes
// ============================================================================

// List all context providers
hooksRouter.get("/context", (c) => {
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
hooksRouter.get("/context/:name", (c) => {
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
hooksRouter.post("/context/:name/enable", (c) => {
  const name = c.req.param("name");
  const provider = contextProviders.get(name);

  if (!provider) {
    return c.json({ error: "Context provider not found" }, 404);
  }

  provider.enabled = true;
  return c.json({ enabled: true, name });
});

hooksRouter.post("/context/:name/disable", (c) => {
  const name = c.req.param("name");
  const provider = contextProviders.get(name);

  if (!provider) {
    return c.json({ error: "Context provider not found" }, 404);
  }

  provider.enabled = false;
  return c.json({ disabled: true, name });
});

// Update context provider priority
hooksRouter.put("/context/:name/priority", async (c) => {
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
