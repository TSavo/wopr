/**
 * Configuration management for WOPR
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { WOPR_HOME, CONFIG_FILE } from "../paths.js";

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
        console.error("Failed to load config:", err.message);
      }
      // Use defaults if file doesn't exist
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.config;
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
