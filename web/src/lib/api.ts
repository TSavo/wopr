/**
 * WOPR API Client
 */

const API_BASE = "/api";

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
  };
}

export interface Session {
  name: string;
  id?: string;
  context?: string;
}

export interface StreamMessage {
  type: "text" | "tool_use" | "complete" | "error";
  content: string;
  toolName?: string;
}

export interface StreamEvent {
  type: "stream" | "injection" | "connected" | "subscribed";
  session?: string;
  from?: string;
  message: StreamMessage;
  ts?: number;
}

export interface WebUiExtension {
  id: string;
  title: string;
  url: string;
  description?: string;
  category?: string;
}

export interface UiComponentExtension {
  id: string;
  title: string;
  moduleUrl: string;
  slot: 'sidebar' | 'settings' | 'statusbar' | 'chat-header' | 'chat-footer';
  description?: string;
}

export interface PluginUiComponentProps {
  api: {
    getSessions: () => Promise<{ sessions: Session[] }>;
    inject: (session: string, message: string) => Promise<InjectResponse>;
    getConfig: () => Promise<WoprConfig>;
    setConfigValue: (key: string, value: any) => Promise<void>;
  };
  currentSession?: string;
  pluginConfig: any;
  saveConfig: (config: any) => Promise<void>;
}

export interface InjectResponse {
  session: string;
  sessionId: string;
  response: string;
  cost: number;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }

  return res.json();
}

export const api = {
  // Sessions
  async getSessions(): Promise<{ sessions: Session[] }> {
    return request("/sessions");
  },

  async createSession(name: string, context?: string): Promise<Session> {
    return request("/sessions", {
      method: "POST",
      body: JSON.stringify({ name, context }),
    });
  },

  async deleteSession(name: string): Promise<void> {
    await request(`/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },

  async inject(session: string, message: string): Promise<InjectResponse> {
    return request(`/sessions/${encodeURIComponent(session)}/inject`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  },

  // Auth
  async getAuthStatus(): Promise<{ authenticated: boolean; type?: string }> {
    return request("/auth");
  },

  // Crons
  async getCrons(): Promise<{ crons: any[] }> {
    return request("/crons");
  },

  async createCron(cron: {
    name: string;
    schedule: string;
    session: string;
    message: string;
  }): Promise<any> {
    return request("/crons", {
      method: "POST",
      body: JSON.stringify(cron),
    });
  },

  async deleteCron(name: string): Promise<void> {
    await request(`/crons/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  },

  // Peers
  async getPeers(): Promise<{ peers: any[] }> {
    return request("/peers");
  },

  // Plugins
  async getPlugins(): Promise<{ plugins: any[] }> {
    return request("/plugins");
  },

  // Web UI Extensions
  async getWebUiExtensions(): Promise<{ extensions: WebUiExtension[] }> {
    return request("/plugins/ui");
  },

  // UI Component Extensions
  async getUiComponents(): Promise<{ components: UiComponentExtension[] }> {
    return request("/plugins/components");
  },

  // Identity
  async getIdentity(): Promise<any> {
    return request("/identity");
  },

  async initIdentity(force?: boolean): Promise<any> {
    return request("/identity", {
      method: "POST",
      body: JSON.stringify({ force }),
    });
  },

  // Config
  async getConfig(): Promise<WoprConfig> {
    return request("/config");
  },

  async getConfigValue(key: string): Promise<any> {
    const data = await request<{ key: string; value: any }>(`/config/${encodeURIComponent(key)}`);
    return data.value;
  },

  async setConfigValue(key: string, value: any): Promise<void> {
    await request(`/config/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  },

  async resetConfig(): Promise<void> {
    await request("/config", {
      method: "DELETE",
    });
  },
};
