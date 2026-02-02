/**
 * Plugins API routes
 */

import { Hono } from "hono";
import {
  installPlugin,
  removePlugin,
  enablePlugin,
  disablePlugin,
  listPlugins,
  searchPlugins,
  addRegistry,
  removeRegistry,
  listRegistries,
  getWebUiExtensions,
  getUiComponents,
  getPluginExtension,
} from "../../plugins.js";

export const pluginsRouter = new Hono();

// List installed plugins
pluginsRouter.get("/", (c) => {
  const plugins = listPlugins();
  return c.json({
    plugins: plugins.map((p: { name: string; version: string; description?: string; source: string; enabled: boolean; installedAt: number }) => ({
      name: p.name,
      version: p.version,
      description: p.description || null,
      source: p.source,
      enabled: p.enabled,
      installedAt: p.installedAt,
    })),
  });
});

// List plugin-provided Web UI extensions
pluginsRouter.get("/ui", (c) => {
  const extensions = getWebUiExtensions();
  return c.json({ extensions });
});

// List plugin-provided UI components
pluginsRouter.get("/components", (c) => {
  const components = getUiComponents();
  return c.json({ components });
});

// Install plugin
pluginsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { source } = body;

  if (!source) {
    return c.json({ error: "source is required" }, 400);
  }

  try {
    const plugin = await installPlugin(source);
    // Auto-enable plugin after installation
    enablePlugin(plugin.name);
    return c.json({
      installed: true,
      plugin: {
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        source: plugin.source,
        enabled: true,
      },
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Remove plugin
pluginsRouter.delete("/:name", async (c) => {
  const name = c.req.param("name");

  try {
    await removePlugin(name);
    return c.json({ removed: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Enable plugin
pluginsRouter.post("/:name/enable", (c) => {
  const name = c.req.param("name");

  try {
    enablePlugin(name);
    return c.json({ enabled: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Disable plugin
pluginsRouter.post("/:name/disable", (c) => {
  const name = c.req.param("name");

  try {
    disablePlugin(name);
    return c.json({ disabled: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Search npm for plugins
pluginsRouter.get("/search", async (c) => {
  const query = c.req.query("q");

  if (!query) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const results = await searchPlugins(query);
  return c.json({ results });
});

// Plugin registries
pluginsRouter.get("/registries", (c) => {
  const registries = listRegistries();
  return c.json({ registries });
});

pluginsRouter.post("/registries", async (c) => {
  const body = await c.req.json();
  const { name, url } = body;

  if (!name || !url) {
    return c.json({ error: "name and url are required" }, 400);
  }

  addRegistry(name, url);
  return c.json({ added: true, name, url }, 201);
});

pluginsRouter.delete("/registries/:name", (c) => {
  const name = c.req.param("name");
  removeRegistry(name);
  return c.json({ removed: true });
});

// Discord owner claim - call the Discord plugin's claimOwnership function
pluginsRouter.post("/discord/claim", async (c) => {
  const body = await c.req.json();
  const { code } = body;

  if (!code) {
    return c.json({ error: "code is required" }, 400);
  }

  // Get the Discord extension
  interface DiscordExtension {
    claimOwnership: (code: string) => Promise<{ success: boolean; userId?: string; username?: string; error?: string }>;
  }
  const discordExt = getPluginExtension<DiscordExtension>("discord");

  if (!discordExt) {
    return c.json({ error: "Discord plugin not loaded" }, 404);
  }

  if (!discordExt.claimOwnership) {
    return c.json({ error: "Discord plugin does not support ownership claiming" }, 400);
  }

  const result = await discordExt.claimOwnership(code);
  if (result.success) {
    return c.json({
      success: true,
      userId: result.userId,
      username: result.username,
    });
  } else {
    return c.json({ success: false, error: result.error }, 400);
  }
});
