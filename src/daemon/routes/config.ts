/**
 * Config API routes
 */

import { Hono } from "hono";
import { config } from "../../core/config.js";

export const configRouter = new Hono();

// GET /config - Get all config
configRouter.get("/", async (c) => {
  await config.load();
  return c.json(config.get());
});

// GET /config/:key - Get specific config value
configRouter.get("/:key", async (c) => {
  await config.load();
  const key = c.req.param("key");
  const value = config.getValue(key);

  if (value === undefined) {
    return c.json({ error: `Config key "${key}" not found` }, 404);
  }

  return c.json({ key, value });
});

// PUT /config/:key - Set config value
configRouter.put("/:key", async (c) => {
  await config.load();
  const key = c.req.param("key");
  const { value } = await c.req.json();

  if (value === undefined) {
    return c.json({ error: "Missing value in request body" }, 400);
  }

  config.setValue(key, value);
  await config.save();

  return c.json({ key, value });
});

// DELETE /config - Reset to defaults
configRouter.delete("/", async (c) => {
  config.reset();
  await config.save();
  return c.json({ message: "Config reset to defaults" });
});
