/**
 * Configuration management for WOPR
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { WOPR_HOME, CONFIG_FILE } from "../paths.js";

import { logger } from "../logger.js";
/**
 * Per-provider default settings
 */
export interface ProviderDefaults {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoningEffort?: string; // For Codex: minimal/low/medium/high/xhigh
  options?: Record<string, unknown>;
}

export interface WoprConfig {
  daemon: {
    port: number;
    host: string;
    autoStart: boolean;
  };
  anthropic: {
    apiKey?: string;
  };
  oauth: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  discord?: {
    token?: string;
    guildId?: string;
  };
  discovery: {
    topics: string[];
    autoJoin: boolean;
  };
  plugins: {
    autoLoad: boolean;
    directories: string[];
    // Plugin-specific config stored here: plugins.data[pluginName]
    data?: Record<string, any>;
  };
  agents?: {
    a2a?: {
      enabled: boolean;
    };
  };
  /**
   * Per-provider default settings
   * e.g., providers.codex.model = "gpt-5.2"
   *       providers.anthropic.model = "claude-opus-4-5-20251101"
   */
  providers?: Record<string, ProviderDefaults>;
}

const DEFAULT_CONFIG: WoprConfig = {
  daemon: {
    port: 7437,
    host: "127.0.0.1",
    autoStart: false,
  },
  anthropic: {},
  oauth: {},
  discovery: {
    topics: [],
    autoJoin: false,
  },
  plugins: {
    autoLoad: true,
    directories: [join(WOPR_HOME, "plugins")],
    data: {},
  },
  providers: {},
};

export class ConfigManager {
  private config: WoprConfig = DEFAULT_CONFIG;

  async load(): Promise<WoprConfig> {
    try {
      const data = await readFile(CONFIG_FILE, "utf-8");
      const loaded = JSON.parse(data) as Partial<WoprConfig>;
      this.config = this.merge(DEFAULT_CONFIG, loaded);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        logger.error("Failed to load config:", err.message);
      }
      // Use defaults if file doesn't exist
      this.config = { ...DEFAULT_CONFIG };
    }

    // Apply environment variable overrides (for Docker/container deployment)
    this.applyEnvironmentOverrides();

    return this.config;
  }

  /**
   * Apply environment variable overrides to config
   * Environment variables take precedence over config file values
   */
  private applyEnvironmentOverrides(): void {
    // Anthropic API key
    if (process.env.ANTHROPIC_API_KEY) {
      this.config.anthropic = this.config.anthropic || {};
      this.config.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
    }

    // Discord configuration
    if (process.env.DISCORD_TOKEN) {
      this.config.discord = this.config.discord || {};
      this.config.discord.token = process.env.DISCORD_TOKEN;
    }
    if (process.env.DISCORD_GUILD_ID) {
      this.config.discord = this.config.discord || {};
      this.config.discord.guildId = process.env.DISCORD_GUILD_ID;
    }

    // Daemon configuration
    if (process.env.WOPR_DAEMON_PORT) {
      this.config.daemon.port = parseInt(process.env.WOPR_DAEMON_PORT, 10);
    }
    if (process.env.WOPR_DAEMON_HOST) {
      this.config.daemon.host = process.env.WOPR_DAEMON_HOST;
    }
  }

  async save(): Promise<void> {
    try {
      await mkdir(WOPR_HOME, { recursive: true });
      await writeFile(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (err: any) {
      throw new Error(`Failed to save config: ${err.message}`);
    }
  }

  get(): WoprConfig {
    return { ...this.config };
  }

  getValue(key: string): any {
    const parts = key.split(".");
    let value: any = this.config;
    for (const part of parts) {
      if (value && typeof value === "object" && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }
    return value;
  }

  setValue(key: string, value: any): void {
    const parts = key.split(".");
    let target: any = this.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in target)) {
        target[part] = {};
      }
      target = target[part];
    }

    const lastPart = parts[parts.length - 1];
    target[lastPart] = value;
  }

  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * Get default settings for a provider
   * Used for global provider defaults (model, temperature, etc.)
   */
  getProviderDefaults(providerId: string): ProviderDefaults | undefined {
    return this.config.providers?.[providerId];
  }

  /**
   * Set a provider default setting
   * e.g., setProviderDefault("codex", "model", "gpt-5.2")
   */
  setProviderDefault(providerId: string, key: keyof ProviderDefaults, value: any): void {
    if (!this.config.providers) {
      this.config.providers = {};
    }
    if (!this.config.providers[providerId]) {
      this.config.providers[providerId] = {};
    }
    (this.config.providers[providerId] as any)[key] = value;
  }

  private merge(defaults: any, overrides: any): any {
    const result: any = { ...defaults };
    for (const key in overrides) {
      if (overrides[key] !== null && typeof overrides[key] === "object" && !Array.isArray(overrides[key])) {
        result[key] = this.merge(defaults[key] || {}, overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }
}

// Singleton instance
export const config = new ConfigManager();
