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
  Peer,
  StreamCallback,
  ChannelAdapter,
  ChannelRef,
  MessageMiddleware,
  MiddlewareInput,
  MiddlewareOutput,
  WebUiExtension,
  UiComponentExtension,
  ContextProvider,
  ConfigSchema,
} from "./types.js";
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

const WOPR_HOME = process.env.WOPR_HOME || join(process.env.HOME || "~", ".wopr");
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
export const messageMiddlewares: Map<string, MessageMiddleware> = new Map();
const webUiExtensions: Map<string, WebUiExtension> = new Map();
const uiComponents: Map<string, UiComponentExtension> = new Map();

// Provider plugins registry (for providers registered via plugins)
const providerPlugins: Map<string, ModelProvider> = new Map();

// Config schemas registry (pluginId -> schema)
const configSchemas: Map<string, ConfigSchema> = new Map();

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
      console.log(`[plugins] Installing dependencies for ${repo}...`);
      execSync("npm install", { cwd: pluginDir, stdio: "inherit" });
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
      console.log(`[plugins] Installing dependencies for local plugin...`);
      execSync("npm install", { cwd: pluginDir, stdio: "inherit" });
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
    inject: (session: string, message: string, onStream?: StreamCallback) => Promise<string>;
    injectPeer: (peer: string, session: string, message: string) => Promise<string>;
    getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
    getSessions: () => string[];
    getPeers: () => Peer[];
  }
): WOPRPluginContext {
  const pluginName = plugin.name;

  return {
    inject: (session: string, message: string, onStream?: StreamCallback) =>
      injectors.inject(session, message, onStream),
    injectPeer: injectors.injectPeer,
    getIdentity: injectors.getIdentity,
    getSessions: injectors.getSessions,
    getPeers: injectors.getPeers,

    on(event: "injection" | "stream", handler: InjectionHandler | StreamHandler) {
      pluginEvents.on(event, handler);
    },

    off(event: "injection" | "stream", handler: InjectionHandler | StreamHandler) {
      pluginEvents.off(event, handler);
    },

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

    registerMiddleware(middleware: MessageMiddleware) {
      messageMiddlewares.set(middleware.name, middleware);
    },

    unregisterMiddleware(name: string) {
      messageMiddlewares.delete(name);
    },

    getMiddlewares() {
      return getSortedMiddlewares();
    },

    getMiddlewareChain() {
      return getMiddlewareChain();
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
      providerPlugins.set(provider.id, provider);
      providerRegistry.register(provider);
    },

    unregisterProvider(id: string) {
      providerPlugins.delete(id);
      // Note: providerRegistry doesn't have unregister, providers are removed from runtime only
    },

    getProvider(id: string): ModelProvider | undefined {
      return providerPlugins.get(id) || providerRegistry.listProviders().find(p => p.id === id) as unknown as ModelProvider;
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

    log: createPluginLogger(plugin.name),

    getPluginDir(): string {
      return plugin.source === "local" ? plugin.path : join(PLUGINS_DIR, plugin.name);
    },
  };
}

export async function loadPlugin(
  installed: InstalledPlugin,
  injectors: {
    inject: (session: string, message: string, onStream?: StreamCallback) => Promise<string>;
    injectPeer: (peer: string, session: string, message: string) => Promise<string>;
    getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
    getSessions: () => string[];
    getPeers: () => Peer[];
  }
): Promise<WOPRPlugin> {
  // Find the entry point
  let entryPoint = installed.path;
  if (existsSync(join(installed.path, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(installed.path, "package.json"), "utf-8"));
    entryPoint = join(installed.path, pkg.main || "index.js");
  } else if (existsSync(join(installed.path, "index.js"))) {
    entryPoint = join(installed.path, "index.js");
  } else if (existsSync(join(installed.path, "index.ts"))) {
    entryPoint = join(installed.path, "index.ts");
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

export async function searchPlugins(query: string): Promise<any[]> {
  // TODO: Implement search across registries
  // For now, return empty results
  return [];
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

export function getMiddlewares(): MessageMiddleware[] {
  return getSortedMiddlewares();
}

export function getMiddlewareChain(): { name: string; priority: number; enabled: boolean }[] {
  return getSortedMiddlewares().map(m => ({
    name: m.name,
    priority: m.priority ?? 100,
    enabled: m.enabled !== false
  }));
}

function getSortedMiddlewares(): MessageMiddleware[] {
  return Array.from(messageMiddlewares.values())
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

function isMiddlewareEnabled(middleware: MessageMiddleware, data: MiddlewareInput | MiddlewareOutput): boolean {
  if (typeof middleware.enabled === "function") {
    return middleware.enabled(data);
  }
  return middleware.enabled !== false;
}

export async function applyIncomingMiddlewares(input: MiddlewareInput): Promise<string | null> {
  let message = input.message;
  
  for (const middleware of getSortedMiddlewares()) {
    if (!middleware.onIncoming) continue;
    if (!isMiddlewareEnabled(middleware, input)) continue;
    
    try {
      const result = await middleware.onIncoming({ ...input, message });
      if (result === null) return null;
      message = result;
    } catch (err) {
      console.error(`[middleware] ${middleware.name} failed on incoming:`, err);
      // Continue to next middleware or block? Let's continue for resilience
    }
  }
  return message;
}

export async function applyOutgoingMiddlewares(output: MiddlewareOutput): Promise<string | null> {
  let response = output.response;
  
  for (const middleware of getSortedMiddlewares()) {
    if (!middleware.onOutgoing) continue;
    if (!isMiddlewareEnabled(middleware, output)) continue;
    
    try {
      const result = await middleware.onOutgoing({ ...output, response });
      if (result === null) return null;
      response = result;
    } catch (err) {
      console.error(`[middleware] ${middleware.name} failed on outgoing:`, err);
    }
  }
  return response;
}

// ============================================================================
// Plugin Logger
// ============================================================================

function createPluginLogger(pluginName: string): PluginLogger {
  return {
    info: (message: string, ...args: any[]) => {
      console.log(`[${pluginName}] ${message}`, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      console.warn(`[${pluginName}] ${message}`, ...args);
    },
    error: (message: string, ...args: any[]) => {
      console.error(`[${pluginName}] ${message}`, ...args);
    },
    debug: (message: string, ...args: any[]) => {
      if (process.env.DEBUG) {
        console.debug(`[${pluginName}] ${message}`, ...args);
      }
    },
  };
}

// ============================================================================
// Batch Plugin Operations
// ============================================================================

export async function loadAllPlugins(injectors: {
  inject: (session: string, message: string, onStream?: StreamCallback) => Promise<string>;
  injectPeer: (peer: string, session: string, message: string) => Promise<string>;
  getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
  getSessions: () => string[];
  getPeers: () => Peer[];
}): Promise<void> {
  const installed = getInstalledPlugins();
  
  for (const plugin of installed) {
    if (!plugin.enabled) continue;
    
    try {
      await loadPlugin(plugin, injectors);
      console.log(`[plugins] Loaded: ${plugin.name}`);
    } catch (err) {
      console.error(`[plugins] Failed to load ${plugin.name}:`, err);
    }
  }
}

export async function shutdownAllPlugins(): Promise<void> {
  for (const [name] of loadedPlugins) {
    try {
      await unloadPlugin(name);
      console.log(`[plugins] Unloaded: ${name}`);
    } catch (err) {
      console.error(`[plugins] Failed to unload ${name}:`, err);
    }
  }
}
