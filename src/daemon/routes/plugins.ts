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
  loadPlugin,
  unloadPlugin,
} from "../../plugins.js";
import { inject, getSessions } from "../../core/sessions.js";
import { providerRegistry } from "../../core/providers.js";
import type { PluginInjectOptions } from "../../types.js";

export const pluginsRouter = new Hono();

// Create injectors for hot-loading plugins (same as daemon/index.ts)
function createInjectors() {
  return {
    inject: async (session: string, message: string, options?: PluginInjectOptions): Promise<string> => {
      // Parse `from` field to create security source if not provided
      let source = options?.source;
      if (!source && options?.from) {
        const { createInjectionSource } = await import("../../security/types.js");
        const from = options.from;

        if (from.startsWith("p2p:")) {
          const peerKey = from.slice(4);
          source = createInjectionSource("p2p", {
            trustLevel: "untrusted",
            identity: { publicKey: peerKey },
          });
        } else if (from === "cron") {
          source = createInjectionSource("cron");
        } else if (from === "api") {
          source = createInjectionSource("api", { trustLevel: "semi-trusted" });
        } else if (from.startsWith("plugin:")) {
          const pluginName = from.slice(7);
          source = createInjectionSource("plugin", {
            identity: { pluginName },
          });
        }
      }

      const result = await inject(session, message, { silent: true, ...options, source });
      return result.response;
    },
    getSessions: () => Object.keys(getSessions()),
  };
}

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

    // Hot-load the plugin immediately (no restart required)
    const injectors = createInjectors();
    await loadPlugin(plugin, injectors);

    // Run health check for any newly registered providers
    await providerRegistry.checkHealth();

    return c.json({
      installed: true,
      plugin: {
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        source: plugin.source,
        enabled: true,
        loaded: true,
      },
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Remove plugin (hot-unloads first)
pluginsRouter.delete("/:name", async (c) => {
  const name = c.req.param("name");

  try {
    // Hot-unload the plugin first
    await unloadPlugin(name);

    await removePlugin(name);
    return c.json({ removed: true, unloaded: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Enable plugin (hot-loads if not already loaded)
pluginsRouter.post("/:name/enable", async (c) => {
  const name = c.req.param("name");

  try {
    const plugins = listPlugins();
    const plugin = plugins.find((p: { name: string }) => p.name === name);
    if (!plugin) {
      return c.json({ error: "Plugin not found" }, 404);
    }

    enablePlugin(name);

    // Hot-load the plugin
    const injectors = createInjectors();
    await loadPlugin(plugin, injectors);

    // Run health check for any newly registered providers
    await providerRegistry.checkHealth();

    return c.json({ enabled: true, loaded: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Disable plugin (hot-unloads)
pluginsRouter.post("/:name/disable", async (c) => {
  const name = c.req.param("name");

  try {
    // Hot-unload the plugin first
    await unloadPlugin(name);

    disablePlugin(name);
    return c.json({ disabled: true, unloaded: true });
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
