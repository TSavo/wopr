import { logger } from "./logger.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { EventEmitter } from "events";
import { config as centralConfig } from "./core/config.js";
import {
  WOPRPlugin,
  WOPRPluginContext,
  PluginCommand,
  InstalledPlugin,
  PluginRegistryEntry,
  PluginLogger,
  InjectionHandler,
  StreamHandler,
  SessionStreamEvent,
  StreamMessage,
  StreamCallback,
  ChannelAdapter,
  ChannelRef,
  WebUiExtension,
  UiComponentExtension,
  ContextProvider,
  ConfigSchema,
  PluginInjectOptions,
  HookOptions,
} from "./types.js";
import { logMessage as logMessageToSession } from "./core/sessions.js";
import {
  registerContextProvider as registerCtxProvider,
  unregisterContextProvider as unregisterCtxProvider,
  getContextProvider as getCtxProvider,
} from "./core/context.js";
import { providerRegistry } from "./core/providers.js";
import type { ModelProvider } from "./types/provider.js";
import type { 
  ContextPart, 
  MessageInfo 
} from "./core/context.js";
import { resolveIdentity, resolveUserProfile } from "./core/workspace.js";
import { eventBus } from "./core/events.js";
import type {
  WOPREventBus,
  WOPRHookManager,
  EventHandler,
  MutableHookEvent,
  SessionInjectEvent,
  ChannelMessageEvent,
} from "./types.js";
import { getVoiceRegistry } from "./voice/index.js";
import type { STTProvider, TTSProvider, VoicePluginRequirements, InstallMethod } from "./voice/types.js";
import {
  checkRequirements,
  ensureRequirements,
  formatMissingRequirements,
} from "./plugins/requirements.js";

import { homedir } from "os";
const WOPR_HOME = process.env.WOPR_HOME || join(homedir(), "wopr");
const PLUGINS_DIR = join(WOPR_HOME, "plugins");
const PLUGINS_FILE = join(WOPR_HOME, "plugins.json");
const REGISTRIES_FILE = join(WOPR_HOME, "plugin-registries.json");

// Event emitter for injection events
const pluginEvents = new EventEmitter();

// Loaded plugins (runtime)
const loadedPlugins: Map<string, { plugin: WOPRPlugin; context: WOPRPluginContext }> = new Map();

// Context providers - session -> provider mapping
const contextProviders: Map<string, ContextProvider> = new Map();
const channelAdapters: Map<string, ChannelAdapter> = new Map();
const webUiExtensions: Map<string, WebUiExtension> = new Map();
const uiComponents: Map<string, UiComponentExtension> = new Map();

// Provider plugins registry (for providers registered via plugins)
const providerPlugins: Map<string, ModelProvider> = new Map();

// Config schemas registry (pluginId -> schema)
const configSchemas: Map<string, ConfigSchema> = new Map();

// Plugin extensions registry - plugins can expose APIs to other plugins
// Key format: "pluginName.extensionName" -> extension object
const pluginExtensions: Map<string, unknown> = new Map();

/**
 * Register a plugin extension that other plugins can access
 * @param pluginName - Name of the plugin registering the extension
 * @param extensionName - Name of the extension (e.g., "p2p", "discord")
 * @param extension - The extension object with methods/properties
 */
export function registerPluginExtension(pluginName: string, extensionName: string, extension: unknown): void {
  const key = `${pluginName}.${extensionName}`;
  pluginExtensions.set(key, extension);
  logger.info(`[plugins] Extension registered: ${key}`);
}

/**
 * Unregister a plugin extension
 */
export function unregisterPluginExtension(pluginName: string, extensionName: string): void {
  const key = `${pluginName}.${extensionName}`;
  pluginExtensions.delete(key);
  logger.info(`[plugins] Extension unregistered: ${key}`);
}

/**
 * Get a plugin extension by name
 * @param extensionName - Full name (plugin.extension) or just extension name
 */
export function getPluginExtension<T = unknown>(extensionName: string): T | undefined {
  // Try exact match first
  if (pluginExtensions.has(extensionName)) {
    return pluginExtensions.get(extensionName) as T;
  }
  // Try to find by extension name suffix
  for (const [key, ext] of pluginExtensions) {
    if (key.endsWith(`.${extensionName}`)) {
      return ext as T;
    }
  }
  return undefined;
}

/**
 * List all registered extensions
 */
export function listPluginExtensions(): string[] {
  return Array.from(pluginExtensions.keys());
}

function channelKey(channel: ChannelRef): string {
  return `${channel.type}:${channel.id}`;
}

// ============================================================================
// Plugin Installation
// ============================================================================

export interface InstallResult {
  name: string;
  version: string;
  path: string;
  enabled: boolean;
}

export async function installPlugin(source: string): Promise<InstalledPlugin> {
  mkdirSync(PLUGINS_DIR, { recursive: true });

  // Determine source type
  if (source.startsWith("github:")) {
    // GitHub repo
    const repo = source.replace("github:", "");
    const pluginDir = join(PLUGINS_DIR, repo.split("/")[1] || repo);
    
    // Clone or pull
    if (existsSync(pluginDir)) {
      execSync("git pull", { cwd: pluginDir, stdio: "inherit" });
    } else {
      execSync(`git clone https://github.com/${repo} "${pluginDir}"`, { stdio: "inherit" });
    }

    // Install dependencies if package.json exists
    const pkgPath = join(pluginDir, "package.json");
    if (existsSync(pkgPath)) {
      logger.info(`[plugins] Installing dependencies for ${repo}...`);
      execSync("npm install", { cwd: pluginDir, stdio: "inherit" });
      
      // Build TypeScript plugins if tsconfig.json exists
      if (existsSync(join(pluginDir, "tsconfig.json"))) {
        logger.info(`[plugins] Building TypeScript plugin...`);
        execSync("npm run build", { cwd: pluginDir, stdio: "inherit" });
      }
    }

    // Read package.json for metadata
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")) : {};

    const installed: InstalledPlugin = {
      name: pkg.name || repo.split("/")[1] || repo,
      version: pkg.version || "0.0.0",
      description: pkg.description,
      source: "github",
      path: pluginDir,
      enabled: false,
      installedAt: Date.now(),
    };

    addInstalledPlugin(installed);
    return installed;
  } else if (source.startsWith("./") || source.startsWith("/") || source.startsWith("~/")) {
    // Local path
    const resolved = resolve(source.replace("~", process.env.HOME || "~"));
    const pluginDir = join(PLUGINS_DIR, resolved.split("/").pop() || "plugin");
    
    // Symlink or copy
    if (!existsSync(pluginDir)) {
      execSync(`ln -s "${resolved}" "${pluginDir}"`);
    }

    // Install dependencies if package.json exists
    const pkgPath = join(pluginDir, "package.json");
    if (existsSync(pkgPath)) {
      logger.info(`[plugins] Installing dependencies for local plugin...`);
      execSync("npm install", { cwd: pluginDir, stdio: "inherit" });
      
      // Build TypeScript plugins if tsconfig.json exists
      if (existsSync(join(pluginDir, "tsconfig.json"))) {
        logger.info(`[plugins] Building TypeScript plugin...`);
        execSync("npm run build", { cwd: pluginDir, stdio: "inherit" });
      }
    }

    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")) : {};

    const installed: InstalledPlugin = {
      name: pkg.name || resolved.split("/").pop() || "plugin",
      version: pkg.version || "0.0.0",
      description: pkg.description,
      source: "local",
      path: pluginDir,
      enabled: false,
      installedAt: Date.now(),
    };

    addInstalledPlugin(installed);
    return installed;
  } else {
    // npm package - normalize to wopr-plugin-<name> format (accept wopr-<name> too)
    const shortName = source.replace(/^wopr-plugin-/, "").replace(/^wopr-/, "");
    const npmPackage = source.startsWith("wopr-") && !source.startsWith("wopr-plugin-")
      ? source
      : `wopr-plugin-${shortName}`;
    const pluginDir = join(PLUGINS_DIR, shortName);
    mkdirSync(pluginDir, { recursive: true });

    // Use npm to install
    execSync(`npm install "${npmPackage}"`, { cwd: pluginDir, stdio: "inherit" });

    // Read installed package metadata
    const pkgPath = join(pluginDir, "node_modules", npmPackage, "package.json");
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")) : {};

    const installed: InstalledPlugin = {
      name: shortName,
      version: pkg.version || "0.0.0",
      description: pkg.description,
      source: "npm",
      path: join(pluginDir, "node_modules", npmPackage),
      enabled: false,
      installedAt: Date.now(),
    };

    addInstalledPlugin(installed);
    return installed;
  }
}

export function removePlugin(name: string): boolean {
  return uninstallPlugin(name);
}

export function uninstallPlugin(name: string): boolean {
  const installed = getInstalledPlugins();
  const plugin = installed.find(p => p.name === name);
  if (!plugin) return false;

  // Remove files
  if (existsSync(plugin.path)) {
    execSync(`rm -rf "${plugin.path}"`);
  }

  // Remove from registry
  const remaining = installed.filter(p => p.name !== name);
  writeFileSync(PLUGINS_FILE, JSON.stringify(remaining, null, 2));

  return true;
}

export function enablePlugin(name: string): boolean {
  const installed = getInstalledPlugins();
  const plugin = installed.find(p => p.name === name);
  if (!plugin) return false;

  plugin.enabled = true;
  writeFileSync(PLUGINS_FILE, JSON.stringify(installed, null, 2));
  return true;
}

export function disablePlugin(name: string): boolean {
  const installed = getInstalledPlugins();
  const plugin = installed.find(p => p.name === name);
  if (!plugin) return false;

  plugin.enabled = false;
  writeFileSync(PLUGINS_FILE, JSON.stringify(installed, null, 2));
  return true;
}

export function listPlugins(): InstalledPlugin[] {
  return getInstalledPlugins();
}

export function getInstalledPlugins(): InstalledPlugin[] {
  if (!existsSync(PLUGINS_FILE)) return [];
  return JSON.parse(readFileSync(PLUGINS_FILE, "utf-8"));
}

function addInstalledPlugin(plugin: InstalledPlugin): void {
  const installed = getInstalledPlugins();
  const existing = installed.findIndex(p => p.name === plugin.name);
  if (existing >= 0) {
    installed[existing] = plugin;
  } else {
    installed.push(plugin);
  }
  writeFileSync(PLUGINS_FILE, JSON.stringify(installed, null, 2));
}

// ============================================================================
// Plugin Context Creation
// ============================================================================

function createPluginContext(
  plugin: InstalledPlugin,
  injectors: {
    inject: (session: string, message: string, options?: PluginInjectOptions) => Promise<string>;
    getSessions: () => string[];
  }
): WOPRPluginContext {
  const pluginName = plugin.name;

  return {
    inject: (session: string, message: string, options?: PluginInjectOptions) =>
      injectors.inject(session, message, options),
    logMessage: (session: string, message: string, options?: { from?: string; channel?: ChannelRef }) =>
      logMessageToSession(session, message, options),
    getSessions: injectors.getSessions,

    on(event: "injection" | "stream", handler: InjectionHandler | StreamHandler) {
      pluginEvents.on(event, handler);
    },

    off(event: "injection" | "stream", handler: InjectionHandler | StreamHandler) {
      pluginEvents.off(event, handler);
    },

    // Event bus - reactive primitive for plugin composition
    events: createPluginEventBus(pluginName),

    // Hooks - typed shorthand for common event patterns
    hooks: createPluginHookManager(pluginName),

    registerContextProvider(provider: ContextProvider) {
      registerCtxProvider(provider);
    },

    unregisterContextProvider(name: string) {
      unregisterCtxProvider(name);
    },

    getContextProvider(name: string): ContextProvider | undefined {
      return getCtxProvider(name);
    },

    registerChannel(adapter: ChannelAdapter) {
      channelAdapters.set(channelKey(adapter.channel), adapter);
    },

    unregisterChannel(channel: ChannelRef) {
      channelAdapters.delete(channelKey(channel));
    },

    getChannel(channel: ChannelRef) {
      return channelAdapters.get(channelKey(channel));
    },

    getChannels() {
      return Array.from(channelAdapters.values());
    },

    getChannelsForSession(session: string) {
      return Array.from(channelAdapters.values()).filter(adapter => adapter.session === session);
    },

    registerWebUiExtension(extension: WebUiExtension) {
      webUiExtensions.set(`${pluginName}:${extension.id}`, extension);
    },

    unregisterWebUiExtension(id: string) {
      webUiExtensions.delete(`${pluginName}:${id}`);
    },

    getWebUiExtensions() {
      return Array.from(webUiExtensions.values());
    },

    registerUiComponent(extension: UiComponentExtension) {
      uiComponents.set(`${pluginName}:${extension.id}`, extension);
    },

    unregisterUiComponent(id: string) {
      uiComponents.delete(`${pluginName}:${id}`);
    },

    getUiComponents() {
      return Array.from(uiComponents.values());
    },

    getConfig<T>(): T {
      // Load from central config
      const cfg = centralConfig.get();
      return (cfg.plugins.data?.[pluginName] || {}) as T;
    },

    async saveConfig<T>(pluginConfig: T): Promise<void> {
      // Save to central config
      await centralConfig.load();
      const cfg = centralConfig.get();
      if (!cfg.plugins.data) cfg.plugins.data = {};
      cfg.plugins.data[pluginName] = pluginConfig;
      centralConfig.setValue("plugins.data", cfg.plugins.data);
      await centralConfig.save();
    },

    getMainConfig(key?: string): any {
      // Access main WOPR config (read-only)
      const cfg = centralConfig.get();
      if (!key) return cfg;
      return centralConfig.getValue(key);
    },

    registerProvider(provider: ModelProvider) {
      logger.info(`[plugins] Provider registration: ${provider.id} (${provider.name})`);
      providerPlugins.set(provider.id, provider);
      providerRegistry.register(provider);
      logger.info(`[plugins]   ✓ Provider ${provider.id} registered in registry`);
    },

    unregisterProvider(id: string) {
      providerPlugins.delete(id);
      // Note: providerRegistry doesn't have unregister, providers are removed from runtime only
    },

    getProvider(id: string): ModelProvider | undefined {
      return providerPlugins.get(id) || providerRegistry.listProviders().find(p => p.id === id) as unknown as ModelProvider;
    },

    async getAgentIdentity() {
      // Resolve from workspace IDENTITY.md
      return await resolveIdentity();
    },

    async getUserProfile() {
      // Resolve from workspace USER.md
      return await resolveUserProfile();
    },

    registerConfigSchema(pluginId: string, schema: ConfigSchema) {
      configSchemas.set(pluginId, schema);
    },

    unregisterConfigSchema(pluginId: string) {
      configSchemas.delete(pluginId);
    },

    getConfigSchema(pluginId: string): ConfigSchema | undefined {
      return configSchemas.get(pluginId);
    },

    // Plugin extensions - allow plugins to expose APIs to other plugins
    registerExtension(name: string, extension: unknown) {
      registerPluginExtension(pluginName, name, extension);
    },

    unregisterExtension(name: string) {
      unregisterPluginExtension(pluginName, name);
    },

    getExtension<T = unknown>(name: string): T | undefined {
      return getPluginExtension<T>(name);
    },

    listExtensions(): string[] {
      return listPluginExtensions();
    },

    // Voice extensions - allow voice plugins to register STT/TTS providers
    // and channel plugins to discover and use them
    registerSTTProvider(provider: STTProvider) {
      const voiceRegistry = getVoiceRegistry();
      voiceRegistry.registerSTT(provider);
      // Also register as an extension for discovery via getExtension('stt')
      registerPluginExtension(pluginName, "stt", provider);
      logger.info(`[plugins] STT provider registered: ${provider.metadata.name}`);
    },

    registerTTSProvider(provider: TTSProvider) {
      const voiceRegistry = getVoiceRegistry();
      voiceRegistry.registerTTS(provider);
      // Also register as an extension for discovery via getExtension('tts')
      registerPluginExtension(pluginName, "tts", provider);
      logger.info(`[plugins] TTS provider registered: ${provider.metadata.name}`);
    },

    getSTT(): STTProvider | null {
      return getVoiceRegistry().getSTT();
    },

    getTTS(): TTSProvider | null {
      return getVoiceRegistry().getTTS();
    },

    hasVoice(): { stt: boolean; tts: boolean } {
      const voiceRegistry = getVoiceRegistry();
      return {
        stt: voiceRegistry.getSTT() !== null,
        tts: voiceRegistry.getTTS() !== null,
      };
    },

    log: createPluginLogger(plugin.name),

    getPluginDir(): string {
      return plugin.source === "local" ? plugin.path : join(PLUGINS_DIR, plugin.name);
    },
  };
}

/**
 * Create an event bus instance scoped to a plugin
 */
function createPluginEventBus(pluginName: string): WOPREventBus {
  return {
    on<T extends keyof import("./types.js").WOPREventMap>(
      event: T,
      handler: EventHandler<import("./types.js").WOPREventMap[T]>
    ): () => void {
      // Wrap handler to identify plugin source
      const wrappedHandler: EventHandler<any> = async (payload, evt) => {
        // Add plugin source to event metadata
        const eventWithSource = { ...evt, source: pluginName };
        await handler(payload, eventWithSource);
      };
      
      // Store reference for off()
      (wrappedHandler as any)._original = handler;
      
      return eventBus.on(event, wrappedHandler);
    },

    once<T extends keyof import("./types.js").WOPREventMap>(
      event: T,
      handler: EventHandler<import("./types.js").WOPREventMap[T]>
    ): void {
      const wrappedHandler: EventHandler<any> = async (payload, evt) => {
        const eventWithSource = { ...evt, source: pluginName };
        await handler(payload, eventWithSource);
      };
      eventBus.once(event, wrappedHandler);
    },

    off<T extends keyof import("./types.js").WOPREventMap>(
      event: T,
      handler: EventHandler<import("./types.js").WOPREventMap[T]>
    ): void {
      eventBus.off(event, handler);
    },

    async emit<T extends keyof import("./types.js").WOPREventMap>(
      event: T,
      payload: import("./types.js").WOPREventMap[T]
    ): Promise<void> {
      await eventBus.emit(event, payload, pluginName);
    },

    async emitCustom(event: string, payload: any): Promise<void> {
      await eventBus.emitCustom(event, payload, pluginName);
    },

    listenerCount(event: string): number {
      return eventBus.listenerCount(event);
    },
  };
}

/**
 * Hook registration entry with metadata
 */
interface HookEntry {
  handler: Function;
  priority: number;
  name?: string;
  once: boolean;
  unsubscribe: () => void;
}

/**
 * Create a hook manager scoped to a plugin
 * Hooks provide typed, mutable access to core lifecycle events
 * with priority ordering (lower = runs first)
 */
function createPluginHookManager(pluginName: string): WOPRHookManager {
  // Map of event -> array of hook entries (sorted by priority)
  const hookEntries = new Map<string, HookEntry[]>();

  // Mutable events that can transform data or block
  const mutableEvents = new Set(["message:incoming", "message:outgoing", "channel:message"]);

  // Map hook event names to underlying event bus events
  const eventMapping: Record<string, string> = {
    "message:incoming": "session:beforeInject",
    "message:outgoing": "session:afterInject",
  };

  function getEntries(event: string): HookEntry[] {
    if (!hookEntries.has(event)) {
      hookEntries.set(event, []);
    }
    return hookEntries.get(event)!;
  }

  function insertSorted(entries: HookEntry[], entry: HookEntry): void {
    // Insert in priority order (lower = first)
    const idx = entries.findIndex(e => e.priority > entry.priority);
    if (idx === -1) {
      entries.push(entry);
    } else {
      entries.splice(idx, 0, entry);
    }
  }

  return {
    on(event: string, handler: Function, options?: HookOptions): () => void {
      const priority = options?.priority ?? 100;
      const name = options?.name;
      const once = options?.once ?? false;

      // Resolve to underlying event bus event name
      const busEvent = eventMapping[event] || event;

      // Create unsubscribe function for event bus
      const unsubscribe = eventBus.on(busEvent as any, async (payload, evt) => {
        const entries = getEntries(event);
        const isMutable = mutableEvents.has(event);

        if (isMutable) {
          // Mutable event - handlers can transform data
          let prevented = false;
          const mutableEvent: MutableHookEvent<any> = {
            data: payload,
            session: payload.session || "default",
            preventDefault() {
              prevented = true;
              // Set _prevented on payload for mutable emit functions
              if (payload && typeof payload === "object") {
                (payload as any)._prevented = true;
              }
            },
            isPrevented() { return prevented; },
          };

          for (const entry of [...entries]) {
            await entry.handler(mutableEvent);

            // Handle once option
            if (entry.once) {
              const idx = entries.indexOf(entry);
              if (idx !== -1) {
                entries.splice(idx, 1);
                entry.unsubscribe();
              }
            }

            if (mutableEvent.isPrevented()) break;
          }
        } else {
          // Read-only event
          for (const entry of [...entries]) {
            await entry.handler(payload);

            // Handle once option
            if (entry.once) {
              const idx = entries.indexOf(entry);
              if (idx !== -1) {
                entries.splice(idx, 1);
                entry.unsubscribe();
              }
            }
          }
        }
      });

      const entry: HookEntry = {
        handler,
        priority,
        name,
        once,
        unsubscribe,
      };

      const entries = getEntries(event);
      insertSorted(entries, entry);

      return () => {
        const entries = getEntries(event);
        const idx = entries.indexOf(entry);
        if (idx !== -1) {
          entries.splice(idx, 1);
        }
        unsubscribe();
      };
    },

    off(event: string, handler: Function): void {
      const entries = getEntries(event);
      const idx = entries.findIndex(e => e.handler === handler);
      if (idx !== -1) {
        entries[idx].unsubscribe();
        entries.splice(idx, 1);
      }
    },

    offByName(name: string): void {
      for (const [event, entries] of hookEntries) {
        const toRemove = entries.filter(e => e.name === name);
        for (const entry of toRemove) {
          entry.unsubscribe();
          const idx = entries.indexOf(entry);
          if (idx !== -1) {
            entries.splice(idx, 1);
          }
        }
      }
    },

    list(): Array<{ event: string; name?: string; priority: number }> {
      const result: Array<{ event: string; name?: string; priority: number }> = [];
      for (const [event, entries] of hookEntries) {
        for (const entry of entries) {
          result.push({
            event,
            name: entry.name,
            priority: entry.priority,
          });
        }
      }
      return result.sort((a, b) => a.priority - b.priority);
    },
  } as WOPRHookManager;
}

/** Options for loading plugins */
export interface LoadPluginOptions {
  /** Automatically install missing dependencies */
  autoInstall?: boolean;
  /** Skip requirements check entirely */
  skipRequirementsCheck?: boolean;
  /** Prompt function for interactive install */
  promptInstall?: (message: string) => Promise<boolean>;
}

export async function loadPlugin(
  installed: InstalledPlugin,
  injectors: {
    inject: (session: string, message: string, options?: PluginInjectOptions) => Promise<string>;
    getSessions: () => string[];
  },
  options: LoadPluginOptions = {},
): Promise<WOPRPlugin> {
  // Find the entry point and read package.json
  let entryPoint = installed.path;
  let pkg: any = {};

  if (existsSync(join(installed.path, "package.json"))) {
    pkg = JSON.parse(readFileSync(join(installed.path, "package.json"), "utf-8"));
    entryPoint = join(installed.path, pkg.main || "index.js");
  } else if (existsSync(join(installed.path, "index.js"))) {
    entryPoint = join(installed.path, "index.js");
  } else if (existsSync(join(installed.path, "index.ts"))) {
    entryPoint = join(installed.path, "index.ts");
  }

  // Check requirements from package.json wopr.plugin metadata
  if (!options.skipRequirementsCheck) {
    const pluginMeta = pkg.wopr?.plugin;
    const requires: VoicePluginRequirements | undefined = pluginMeta?.requires;
    const installMethods: InstallMethod[] | undefined = pluginMeta?.install;

    if (requires) {
      logger.info(`[plugins] Checking requirements for ${installed.name}...`);

      const { satisfied, installed: installedDeps, errors } = await ensureRequirements(
        requires,
        installMethods,
        {
          auto: options.autoInstall,
          prompt: options.promptInstall,
        },
      );

      if (!satisfied) {
        const check = await checkRequirements(requires);
        const missing = formatMissingRequirements(check);
        throw new Error(`Plugin ${installed.name} requirements not satisfied:\n${missing}`);
      }

      if (installedDeps.length > 0) {
        logger.info(`[plugins] Installed ${installedDeps.length} dependencies for ${installed.name}`);
      }
    }
  }

  // Temporarily change cwd to plugin directory for proper module resolution
  const originalCwd = process.cwd();
  process.chdir(installed.path);
  
  let module: any;
  try {
    // Dynamic import (tsx handles both JS and TS)
    module = await import(entryPoint);
  } finally {
    process.chdir(originalCwd);
  }
  const plugin: WOPRPlugin = module.default || module;

  // Create context
  const context = createPluginContext(installed, injectors);

  // Store
  loadedPlugins.set(installed.name, { plugin, context });

  // Initialize if needed
  if (plugin.init) {
    await plugin.init(context);
  }

  return plugin;
}

export async function unloadPlugin(name: string): Promise<void> {
  const loaded = loadedPlugins.get(name);
  if (!loaded) return;

  // Shutdown if needed
  if (loaded.plugin.shutdown) {
    await loaded.plugin.shutdown();
  }

  // Clean up registrations
  if (loaded.plugin.commands) {
    // Commands are registered per-plugin, no global registry to clean
  }

  loadedPlugins.delete(name);
}

export function getLoadedPlugin(name: string): { plugin: WOPRPlugin; context: WOPRPluginContext } | undefined {
  return loadedPlugins.get(name);
}

export function getWebUiExtensions(): WebUiExtension[] {
  return Array.from(webUiExtensions.values());
}

export function getUiComponents(): UiComponentExtension[] {
  return Array.from(uiComponents.values());
}

// ============================================================================
// Config Schemas
// ============================================================================

export function getConfigSchemas(): Map<string, ConfigSchema> {
  return configSchemas;
}

export function listConfigSchemas(): { pluginId: string; schema: ConfigSchema }[] {
  return Array.from(configSchemas.entries()).map(([pluginId, schema]) => ({
    pluginId,
    schema,
  }));
}

// ============================================================================
// Plugin Registry
// ============================================================================

export function getPluginRegistries(): PluginRegistryEntry[] {
  if (!existsSync(REGISTRIES_FILE)) return [];
  return JSON.parse(readFileSync(REGISTRIES_FILE, "utf-8"));
}

export function addRegistry(url: string, name?: string): PluginRegistryEntry {
  const registries = getPluginRegistries();
  const entry: PluginRegistryEntry = {
    url,
    name: name || new URL(url).hostname,
    enabled: true,
    lastSync: 0,
  };
  registries.push(entry);
  writeFileSync(REGISTRIES_FILE, JSON.stringify(registries, null, 2));
  return entry;
}

export function removeRegistry(url: string): boolean {
  const registries = getPluginRegistries();
  const filtered = registries.filter(r => r.url !== url);
  if (filtered.length === registries.length) return false;
  writeFileSync(REGISTRIES_FILE, JSON.stringify(filtered, null, 2));
  return true;
}

export function listRegistries(): PluginRegistryEntry[] {
  return getPluginRegistries();
}

export interface DiscoveredPlugin {
  name: string;
  description?: string;
  source: "github" | "npm" | "installed" | "registry";
  url?: string;
  version?: string;
  installed?: boolean;
}

/**
 * Search for plugins across multiple sources
 */
export async function searchPlugins(query: string): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  // 1. Check installed plugins first
  const installed = getInstalledPlugins();
  for (const p of installed) {
    if (!query || p.name.includes(query)) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        results.push({
          name: p.name,
          description: p.description,
          source: "installed",
          version: p.version,
          installed: true,
        });
      }
    }
  }

  // 2. Search GitHub repos (if gh is available)
  try {
    const ghResults = await searchGitHubPlugins(query);
    for (const p of ghResults) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        p.installed = installed.some(i => i.name === p.name);
        results.push(p);
      }
    }
  } catch {
    // gh not available or error, skip
  }

  // 3. Search npm (if online)
  try {
    const npmResults = await searchNpmPlugins(query);
    for (const p of npmResults) {
      if (!seen.has(p.name)) {
        seen.add(p.name);
        p.installed = installed.some(i => i.name === p.name);
        results.push(p);
      }
    }
  } catch {
    // npm search failed, skip
  }

  return results;
}

/**
 * Search GitHub for wopr plugins using gh CLI
 */
async function searchGitHubPlugins(query?: string): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];

  try {
    // Get user's repos matching wopr-plugin-*
    const output = execSync(
      `gh repo list --json name,description,url --limit 100 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    );
    const repos = JSON.parse(output);

    for (const repo of repos) {
      if (repo.name.startsWith("wopr-plugin-")) {
        if (!query || repo.name.includes(query) || repo.description?.includes(query)) {
          results.push({
            name: repo.name,
            description: repo.description,
            source: "github",
            url: repo.url,
          });
        }
      }
    }
  } catch {
    // gh not available or not authenticated
  }

  return results;
}

/**
 * Search npm for wopr plugins
 */
async function searchNpmPlugins(query?: string): Promise<DiscoveredPlugin[]> {
  const results: DiscoveredPlugin[] = [];
  const searchTerm = query ? `wopr-plugin-${query}` : "wopr-plugin-";

  try {
    const output = execSync(
      `npm search "${searchTerm}" --json 2>/dev/null | head -c 50000`,
      { encoding: "utf-8", timeout: 15000 }
    );
    const packages = JSON.parse(output);

    for (const pkg of packages) {
      if (pkg.name.startsWith("wopr-plugin-")) {
        results.push({
          name: pkg.name,
          description: pkg.description,
          source: "npm",
          version: pkg.version,
          url: `https://www.npmjs.com/package/${pkg.name}`,
        });
      }
    }
  } catch {
    // npm search failed
  }

  return results;
}

/**
 * Discover all available voice plugins from GitHub
 */
export async function discoverVoicePlugins(): Promise<{
  stt: DiscoveredPlugin[];
  tts: DiscoveredPlugin[];
  channels: DiscoveredPlugin[];
  cli: DiscoveredPlugin[];
}> {
  const all = await searchPlugins("voice");

  return {
    stt: all.filter(p => p.name.includes("stt") || p.name.includes("whisper") || p.name.includes("deepgram")),
    tts: all.filter(p => p.name.includes("tts") || p.name.includes("piper") || p.name.includes("elevenlabs")),
    channels: all.filter(p => p.name.includes("channel") && p.name.includes("voice")),
    cli: all.filter(p => p.name.includes("voice-cli")),
  };
}

// ============================================================================
// Event Emitters
// ============================================================================

export function emitInjection(session: string, from: string, message: string, response: string) {
  pluginEvents.emit("injection", session, from, message, response);
}

export function emitStream(session: string, from: string, message: StreamMessage) {
  pluginEvents.emit("stream", { session, from, message });
}

// ============================================================================
// Context Providers
// ============================================================================

export function getContextProvider(session: string): ContextProvider | undefined {
  return contextProviders.get(session);
}

export function getChannel(channel: ChannelRef): ChannelAdapter | undefined {
  return channelAdapters.get(channelKey(channel));
}

export function getChannels(): ChannelAdapter[] {
  return Array.from(channelAdapters.values());
}

export function getChannelsForSession(session: string): ChannelAdapter[] {
  return Array.from(channelAdapters.values()).filter(adapter => adapter.session === session);
}

// ============================================================================
// Plugin Logger
// ============================================================================

function createPluginLogger(pluginName: string): PluginLogger {
  return {
    info: (message: string, ...args: any[]) => {
      logger.info(`[${pluginName}] ${message}`, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      logger.warn(`[${pluginName}] ${message}`, ...args);
    },
    error: (message: string, ...args: any[]) => {
      logger.error(`[${pluginName}] ${message}`, ...args);
    },
    debug: (message: string, ...args: any[]) => {
      if (process.env.DEBUG) {
        logger.debug(`[${pluginName}] ${message}`, ...args);
      }
    },
  };
}

// ============================================================================
// Batch Plugin Operations
// ============================================================================

export async function loadAllPlugins(
  injectors: {
    inject: (session: string, message: string, options?: PluginInjectOptions) => Promise<string>;
    getSessions: () => string[];
  },
  options: LoadPluginOptions = {},
): Promise<void> {
  logger.info(`[plugins] loadAllPlugins starting...`);
  logger.info(`[plugins] WOPR_HOME: ${process.env.WOPR_HOME || "not set"}`);
  if (options.autoInstall) {
    logger.info(`[plugins] Auto-install enabled`);
  }

  const installed = getInstalledPlugins();
  logger.info(`[plugins] Found ${installed.length} installed plugins`);

  for (const p of installed) {
    logger.info(`[plugins]  - ${p.name}: enabled=${p.enabled}, path=${p.path}`);
  }

  let loadedCount = 0;
  const failed: { name: string; error: string }[] = [];

  for (const plugin of installed) {
    logger.info(`[plugins] Processing ${plugin.name}...`);
    if (!plugin.enabled) {
      logger.info(`[plugins]   Skipping ${plugin.name} (disabled)`);
      continue;
    }

    logger.info(`[plugins]   Loading ${plugin.name} from ${plugin.path}...`);
    try {
      await loadPlugin(plugin, injectors, options);
      loadedCount++;
      logger.info(`[plugins]   ✓ Loaded: ${plugin.name}`);
    } catch (err: any) {
      logger.error(`[plugins]   ✗ Failed to load ${plugin.name}:`, err.message);
      if (err.stack) {
        logger.error(`[plugins]     Stack:`, err.stack.substring(0, 200));
      }
      failed.push({ name: plugin.name, error: err.message });
    }
  }

  logger.info(`[plugins] loadAllPlugins complete. Loaded ${loadedCount}/${installed.length} plugins`);

  if (failed.length > 0) {
    logger.warn(`[plugins] ${failed.length} plugins failed to load:`);
    for (const f of failed) {
      logger.warn(`[plugins]   - ${f.name}: ${f.error.split("\n")[0]}`);
    }
  }
}

export async function shutdownAllPlugins(): Promise<void> {
  for (const [name] of loadedPlugins) {
    try {
      await unloadPlugin(name);
      logger.info(`[plugins] Unloaded: ${name}`);
    } catch (err) {
      logger.error(`[plugins] Failed to unload ${name}:`, err);
    }
  }
}
