/**
 * Providers API routes
 */

import { Hono } from "hono";
import { providerRegistry } from "../../core/providers.js";

export const providersRouter = new Hono();

// List all providers
providersRouter.get("/", (c) => {
  const providers = providerRegistry.listProviders();
  return c.json({
    providers: providers.map(p => ({
      id: p.id,
      name: p.name,
      available: p.available,
    })),
  });
});

// Add/update provider credential
providersRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { providerId, credential } = body;

  if (!providerId || !credential) {
    return c.json({ error: "providerId and credential are required" }, 400);
  }

  try {
    await providerRegistry.setCredential(providerId, credential);
    return c.json({ success: true, providerId }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Remove provider credential
providersRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    await providerRegistry.removeCredential(id);
    return c.json({ success: true, removed: id });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Health check all providers
providersRouter.post("/health", async (c) => {
  await providerRegistry.checkHealth();
  const providers = providerRegistry.listProviders();
  
  return c.json({
    providers: providers.map(p => ({
      id: p.id,
      name: p.name,
      available: p.available,
    })),
  });
});
