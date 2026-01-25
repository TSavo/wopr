import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { EventEmitter } from "events";
import {
  WOPRPlugin,
  WOPRPluginContext,
  PluginCommand,
  InstalledPlugin,
  PluginRegistryEntry,
  PluginLogger,
  InjectionHandler,
  Peer,
  StreamCallback,
} from "./types.js";

const WOPR_HOME = process.env.WOPR_HOME || join(process.env.HOME || "~", ".wopr");
const PLUGINS_DIR = join(WOPR_HOME, "plugins");
const PLUGINS_FILE = join(WOPR_HOME, "plugins.json");
const REGISTRIES_FILE = join(WOPR_HOME, "plugin-registries.json");

// Event emitter for injection events
const pluginEvents = new EventEmitter();

// Loaded plugins (runtime)
const loadedPlugins: Map<string, { plugin: WOPRPlugin; context: WOPRPluginContext }> = new Map();

// ============================================================================
// Plugin Installation
// ============================================================================

function ensurePluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
}

function getInstalledPlugins(): InstalledPlugin[] {
  if (!existsSync(PLUGINS_FILE)) {
    return [];
  }
  return JSON.parse(readFileSync(PLUGINS_FILE, "utf-8"));
}

function saveInstalledPlugins(plugins: InstalledPlugin[]): void {
  writeFileSync(PLUGINS_FILE, JSON.stringify(plugins, null, 2));
}

export async function installPlugin(source: string): Promise<InstalledPlugin> {
  ensurePluginsDir();

  let plugin: InstalledPlugin;

  if (source.startsWith("github:")) {
    // GitHub: github:user/repo
    const repo = source.slice(7);
    const name = repo.split("/").pop()!.replace(/^wopr-plugin-/, "").replace(/^wopr-/, "");
    const pluginDir = join(PLUGINS_DIR, name);

    console.log(`Cloning ${repo}...`);
    execSync(`git clone https://github.com/${repo}.git "${pluginDir}"`, { stdio: "inherit" });

    // Install dependencies if package.json exists
    if (existsSync(join(pluginDir, "package.json"))) {
      console.log("Installing dependencies...");
      execSync("npm install", { cwd: pluginDir, stdio: "inherit" });
    }

    const pkg = existsSync(join(pluginDir, "package.json"))
      ? JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"))
      : { version: "0.0.0" };

    plugin = {
      name,
      version: pkg.version || "0.0.0",
      description: pkg.description,
      source: "github",
      path: pluginDir,
      enabled: true,
      installedAt: Date.now(),
    };
  } else if (source.startsWith("./") || source.startsWith("/")) {
    // Local directory
    const pluginDir = resolve(source);
    if (!existsSync(pluginDir)) {
      throw new Error(`Plugin directory not found: ${pluginDir}`);
    }

    const pkg = existsSync(join(pluginDir, "package.json"))
      ? JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"))
      : { name: source.split("/").pop(), version: "0.0.0" };

    const name = pkg.name?.replace(/^wopr-plugin-/, "").replace(/^wopr-/, "") || source.split("/").pop()!;

    plugin = {
      name,
      version: pkg.version || "0.0.0",
      description: pkg.description,
      source: "local",
      path: pluginDir,
      enabled: true,
      installedAt: Date.now(),
    };
  } else {
    // npm package - normalize to wopr-plugin-<name> format
    const shortName = source.replace(/^wopr-plugin-/, "").replace(/^wopr-/, "");
    const npmPackage = `wopr-plugin-${shortName}`;
    const pluginDir = join(PLUGINS_DIR, shortName);
    mkdirSync(pluginDir, { recursive: true });

    console.log(`Installing ${npmPackage} from npm...`);
    execSync(`npm install ${npmPackage}`, { cwd: pluginDir, stdio: "inherit" });

    const pkgPath = join(pluginDir, "node_modules", npmPackage, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    plugin = {
      name: shortName,
      version: pkg.version,
      description: pkg.description,
      source: "npm",
      path: join(pluginDir, "node_modules", npmPackage),
      enabled: true,
      installedAt: Date.now(),
    };
  }

  // Add to installed plugins
  const plugins = getInstalledPlugins().filter((p) => p.name !== plugin.name);
  plugins.push(plugin);
  saveInstalledPlugins(plugins);

  console.log(`Installed plugin: ${plugin.name} v${plugin.version}`);
  return plugin;
}

export async function removePlugin(name: string): Promise<void> {
  const plugins = getInstalledPlugins();
  const plugin = plugins.find((p) => p.name === name);

  if (!plugin) {
    throw new Error(`Plugin not found: ${name}`);
  }

  // Unload if loaded
  if (loadedPlugins.has(name)) {
    await unloadPlugin(name);
  }

  // Remove from list
  saveInstalledPlugins(plugins.filter((p) => p.name !== name));

  // Remove directory (except for local plugins)
  if (plugin.source !== "local" && existsSync(plugin.path)) {
    execSync(`rm -rf "${plugin.path}"`);
  }

  console.log(`Removed plugin: ${name}`);
}

export function enablePlugin(name: string): void {
  const plugins = getInstalledPlugins();
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) throw new Error(`Plugin not found: ${name}`);
  plugin.enabled = true;
  saveInstalledPlugins(plugins);
}

export function disablePlugin(name: string): void {
  const plugins = getInstalledPlugins();
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) throw new Error(`Plugin not found: ${name}`);
  plugin.enabled = false;
  saveInstalledPlugins(plugins);
}

export function listPlugins(): InstalledPlugin[] {
  return getInstalledPlugins();
}

// ============================================================================
// Plugin Loading & Context
// ============================================================================

function createPluginLogger(name: string): PluginLogger {
  const prefix = `[plugin:${name}]`;
  return {
    info: (msg, ...args) => console.log(prefix, msg, ...args),
    warn: (msg, ...args) => console.warn(prefix, msg, ...args),
    error: (msg, ...args) => console.error(prefix, msg, ...args),
    debug: (msg, ...args) => {
      if (process.env.WOPR_DEBUG) console.log(prefix, "[debug]", msg, ...args);
    },
  };
}

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
  const configPath = join(
    plugin.source === "local" ? plugin.path : join(PLUGINS_DIR, plugin.name),
    "config.json"
  );

  return {
    inject: (session: string, message: string, onStream?: StreamCallback) =>
      injectors.inject(session, message, onStream),
    injectPeer: injectors.injectPeer,
    getIdentity: injectors.getIdentity,
    getSessions: injectors.getSessions,
    getPeers: injectors.getPeers,

    on(event: "injection", handler: InjectionHandler) {
      pluginEvents.on(event, handler);
    },

    off(event: "injection", handler: InjectionHandler) {
      pluginEvents.off(event, handler);
    },

    getConfig<T>(): T {
      if (!existsSync(configPath)) return {} as T;
      return JSON.parse(readFileSync(configPath, "utf-8"));
    },

    async saveConfig<T>(config: T): Promise<void> {
      const dir = plugin.source === "local" ? plugin.path : join(PLUGINS_DIR, plugin.name);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
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
  }

  // Dynamic import
  const module = await import(entryPoint);
  const plugin: WOPRPlugin = module.default || module;

  if (!plugin.name || !plugin.version) {
    throw new Error(`Invalid plugin: missing name or version`);
  }

  // Create context
  const context = createPluginContext(installed, injectors);

  // Initialize if has init
  if (plugin.init) {
    await plugin.init(context);
  }

  // Store loaded plugin
  loadedPlugins.set(installed.name, { plugin, context });

  return plugin;
}

export async function unloadPlugin(name: string): Promise<void> {
  const loaded = loadedPlugins.get(name);
  if (!loaded) return;

  if (loaded.plugin.shutdown) {
    await loaded.plugin.shutdown();
  }

  loadedPlugins.delete(name);
}

export async function loadAllPlugins(injectors: {
  inject: (session: string, message: string, onStream?: StreamCallback) => Promise<string>;
  injectPeer: (peer: string, session: string, message: string) => Promise<string>;
  getIdentity: () => { publicKey: string; shortId: string; encryptPub: string };
  getSessions: () => string[];
  getPeers: () => Peer[];
}): Promise<void> {
  const plugins = getInstalledPlugins().filter((p) => p.enabled);

  for (const installed of plugins) {
    try {
      await loadPlugin(installed, injectors);
      console.log(`Loaded plugin: ${installed.name}`);
    } catch (err) {
      console.error(`Failed to load plugin ${installed.name}:`, err);
    }
  }
}

export async function shutdownAllPlugins(): Promise<void> {
  for (const [name] of loadedPlugins) {
    await unloadPlugin(name);
  }
}

// Emit injection event to all plugins
export function emitInjection(session: string, from: string, message: string, response: string): void {
  pluginEvents.emit("injection", session, from, message, response);
}

// ============================================================================
// CLI Command Collection
// ============================================================================

export function getPluginCommands(): Map<string, { plugin: string; command: PluginCommand }> {
  const commands = new Map<string, { plugin: string; command: PluginCommand }>();

  // From installed plugins (for CLI help even when not loaded)
  for (const installed of getInstalledPlugins()) {
    const loaded = loadedPlugins.get(installed.name);
    if (loaded?.plugin.commands) {
      for (const cmd of loaded.plugin.commands) {
        commands.set(`${installed.name}:${cmd.name}`, { plugin: installed.name, command: cmd });
      }
    }
  }

  return commands;
}

export function getLoadedPlugin(name: string): { plugin: WOPRPlugin; context: WOPRPluginContext } | undefined {
  return loadedPlugins.get(name);
}

// ============================================================================
// Plugin Registry
// ============================================================================

function getRegistries(): PluginRegistryEntry[] {
  if (!existsSync(REGISTRIES_FILE)) return [];
  return JSON.parse(readFileSync(REGISTRIES_FILE, "utf-8"));
}

function saveRegistries(registries: PluginRegistryEntry[]): void {
  writeFileSync(REGISTRIES_FILE, JSON.stringify(registries, null, 2));
}

export function addRegistry(name: string, url: string): void {
  const registries = getRegistries().filter((r) => r.name !== name);
  registries.push({ name, url, addedAt: Date.now() });
  saveRegistries(registries);
}

export function removeRegistry(name: string): void {
  saveRegistries(getRegistries().filter((r) => r.name !== name));
}

export function listRegistries(): PluginRegistryEntry[] {
  return getRegistries();
}

export async function searchPlugins(query: string): Promise<any[]> {
  // Search npm for wopr-plugin-* packages
  try {
    const result = execSync(`npm search wopr-plugin-${query} --json`, { encoding: "utf-8" });
    return JSON.parse(result);
  } catch {
    return [];
  }
}
