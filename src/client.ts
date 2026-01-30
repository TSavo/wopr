/**
 * WOPR HTTP Client
 *
 * Thin client for communicating with the WOPR daemon.
 */

import type { CronJob, StreamCallback, StreamMessage, ConversationEntry } from "./types.js";
import type { WoprConfig } from "./core/config.js";

const DEFAULT_URL = "http://127.0.0.1:7437";

export interface ClientConfig {
  baseUrl?: string;
}

export interface Session {
  name: string;
  id?: string;
  hasContext: boolean;
}

export interface InjectResult {
  sessionId: string;
  response: string;
  cost: number;
}

export class WoprClient {
  private baseUrl: string;

  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_URL;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: "Request failed" }));
      throw new Error(error.error || `HTTP ${res.status}`);
    }

    return res.json();
  }

  async isRunning(): Promise<boolean> {
    try {
      await this.request("/health");
      return true;
    } catch {
      return false;
    }
  }

  // Sessions
  async getSessions(): Promise<Session[]> {
    const data = await this.request<{ sessions: Session[] }>("/sessions");
    return data.sessions;
  }

  async createSession(name: string, context?: string): Promise<void> {
    await this.request("/sessions", {
      method: "POST",
      body: JSON.stringify({ name, context }),
    });
  }

  async deleteSession(name: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async getSession(name: string): Promise<{ name: string; id?: string; context?: string }> {
    return this.request(`/sessions/${encodeURIComponent(name)}`);
  }

  async getConversationHistory(
    name: string,
    limit?: number
  ): Promise<{ name: string; entries: ConversationEntry[]; count: number }> {
    const url = `/sessions/${encodeURIComponent(name)}/conversation${limit ? `?limit=${limit}` : ""}`;
    return this.request(url);
  }

  async inject(
    session: string,
    message: string,
    onStream?: StreamCallback
  ): Promise<InjectResult> {
    if (onStream) {
      // Use SSE for streaming
      const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(session)}/inject`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({ message }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(error.error || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let result: InjectResult = { sessionId: "", response: "", cost: 0 };
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6)) as StreamMessage & { sessionId?: string; cost?: number };
              onStream(data);
              if (data.type === "text") {
                chunks.push(data.content);
              } else if (data.type === "complete") {
                result.sessionId = data.sessionId || "";
                result.cost = data.cost || 0;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }

      result.response = chunks.join("");
      return result;
    }

    // Non-streaming request
    return this.request(`/sessions/${encodeURIComponent(session)}/inject`, {
      method: "POST",
      body: JSON.stringify({ message }),
    });
  }

  // Crons
  async getCrons(): Promise<CronJob[]> {
    const data = await this.request<{ crons: CronJob[] }>("/crons");
    return data.crons;
  }

  async addCron(cron: Omit<CronJob, "runAt"> & { runAt?: number }): Promise<void> {
    await this.request("/crons", {
      method: "POST",
      body: JSON.stringify(cron),
    });
  }

  async removeCron(name: string): Promise<void> {
    await this.request(`/crons/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  // Auth
  async getAuthStatus(): Promise<{ authenticated: boolean; type?: string; email?: string }> {
    return this.request("/auth");
  }

  // Peers
  async getPeers(): Promise<any[]> {
    const data = await this.request<{ peers: any[] }>("/peers");
    return data.peers;
  }

  async getAccessGrants(): Promise<any[]> {
    const data = await this.request<{ grants: any[] }>("/peers/access");
    return data.grants;
  }

  async revokePeer(peer: string): Promise<void> {
    await this.request(`/peers/${encodeURIComponent(peer)}`, {
      method: "DELETE",
    });
  }

  async namePeer(id: string, name: string): Promise<void> {
    await this.request(`/peers/${encodeURIComponent(id)}/name`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    });
  }

  async injectPeer(peer: string, session: string, message: string): Promise<{ code: number; message?: string }> {
    return this.request("/peers/inject", {
      method: "POST",
      body: JSON.stringify({ peer, session, message }),
    });
  }

  async logMessage(session: string, message: string, from?: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(session)}/log`, {
      method: "POST",
      body: JSON.stringify({ message, from: from || "cli" }),
    });
  }

  async initSessionDocs(session: string, options?: { agentName?: string; userName?: string }): Promise<{ created: string[] }> {
    return this.request(`/sessions/${encodeURIComponent(session)}/init-docs`, {
      method: "POST",
      body: JSON.stringify(options || {}),
    });
  }

  // Plugins
  async getPlugins(): Promise<any[]> {
    const data = await this.request<{ plugins: any[] }>("/plugins");
    return data.plugins;
  }

  async installPlugin(source: string): Promise<void> {
    await this.request("/plugins", {
      method: "POST",
      body: JSON.stringify({ source }),
    });
  }

  async removePlugin(name: string): Promise<void> {
    await this.request(`/plugins/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async enablePlugin(name: string): Promise<void> {
    await this.request(`/plugins/${encodeURIComponent(name)}/enable`, {
      method: "POST",
    });
  }

  async disablePlugin(name: string): Promise<void> {
    await this.request(`/plugins/${encodeURIComponent(name)}/disable`, {
      method: "POST",
    });
  }

  async searchPlugins(query: string): Promise<any[]> {
    const data = await this.request<{ results: any[] }>(`/plugins/search?q=${encodeURIComponent(query)}`);
    return data.results;
  }

  async getPluginRegistries(): Promise<{ name: string; url: string }[]> {
    const data = await this.request<{ registries: { name: string; url: string }[] }>("/plugins/registries");
    return data.registries;
  }

  async addPluginRegistry(name: string, url: string): Promise<void> {
    await this.request("/plugins/registries", {
      method: "POST",
      body: JSON.stringify({ name, url }),
    });
  }

  async removePluginRegistry(name: string): Promise<void> {
    await this.request(`/plugins/registries/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  // Skills
  async getSkills(): Promise<any[]> {
    const data = await this.request<{ skills: any[] }>("/skills");
    return data.skills;
  }

  async installSkill(source: string, name?: string): Promise<void> {
    await this.request("/skills/install", {
      method: "POST",
      body: JSON.stringify({ source, name }),
    });
  }

  async removeSkill(name: string): Promise<void> {
    await this.request(`/skills/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async createSkill(name: string, description?: string): Promise<void> {
    await this.request("/skills/create", {
      method: "POST",
      body: JSON.stringify({ name, description }),
    });
  }

  async searchSkills(query: string): Promise<any[]> {
    const data = await this.request<{ results: any[] }>(`/skills/search?q=${encodeURIComponent(query)}`);
    return data.results;
  }

  async getSkillRegistries(): Promise<{ name: string; url: string }[]> {
    const data = await this.request<{ registries: { name: string; url: string }[] }>("/skills/registries");
    return data.registries;
  }

  async addSkillRegistry(name: string, url: string): Promise<void> {
    await this.request("/skills/registries", {
      method: "POST",
      body: JSON.stringify({ name, url }),
    });
  }

  async removeSkillRegistry(name: string): Promise<void> {
    await this.request(`/skills/registries/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async clearSkillCache(): Promise<void> {
    await this.request("/skills/cache", {
      method: "DELETE",
    });
  }

  // Config
  async getConfig(): Promise<WoprConfig> {
    return this.request("/config");
  }

  async getConfigValue(key: string): Promise<any> {
    const data = await this.request<{ key: string; value: any }>(`/config/${encodeURIComponent(key)}`);
    return data.value;
  }

  async setConfigValue(key: string, value: any): Promise<void> {
    await this.request(`/config/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  }

  async resetConfig(): Promise<void> {
    await this.request("/config", {
      method: "DELETE",
    });
  }

  // Identity
  async getIdentity(): Promise<any | null> {
    try {
      return this.request("/identity");
    } catch {
      return null;
    }
  }

  async initIdentity(force?: boolean): Promise<any> {
    return this.request("/identity", {
      method: "POST",
      body: JSON.stringify({ force }),
    });
  }

  async rotateIdentity(broadcast?: boolean): Promise<any> {
    return this.request("/identity/rotate", {
      method: "POST",
      body: JSON.stringify({ broadcast }),
    });
  }

  async createInvite(peerPubkey: string, sessions: string[]): Promise<{ token: string }> {
    return this.request("/identity/invite", {
      method: "POST",
      body: JSON.stringify({ peerPubkey, sessions }),
    });
  }

  async claimInvite(token: string): Promise<{ code: number; peerKey?: string; sessions?: string[]; message?: string }> {
    return this.request("/identity/claim", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  }

  // Discovery
  async joinTopic(topic: string): Promise<void> {
    await this.request("/discover/join", {
      method: "POST",
      body: JSON.stringify({ topic }),
    });
  }

  async leaveTopic(topic: string): Promise<void> {
    await this.request("/discover/leave", {
      method: "POST",
      body: JSON.stringify({ topic }),
    });
  }

  async getTopics(): Promise<string[]> {
    const data = await this.request<{ topics: string[] }>("/discover/topics");
    return data.topics;
  }

  async getDiscoveredPeers(topic?: string): Promise<any[]> {
    const path = topic ? `/discover/peers?topic=${encodeURIComponent(topic)}` : "/discover/peers";
    const data = await this.request<{ peers: any[] }>(path);
    return data.peers;
  }

  async requestConnection(peerId: string): Promise<{ code: number; sessions?: string[]; message?: string }> {
    return this.request("/discover/connect", {
      method: "POST",
      body: JSON.stringify({ peerId }),
    });
  }

  async getProfile(): Promise<any | null> {
    try {
      return this.request("/discover/profile");
    } catch {
      return null;
    }
  }

  async setProfile(content: Record<string, any>): Promise<any> {
    return this.request("/discover/profile", {
      method: "PUT",
      body: JSON.stringify(content),
    });
  }

  // Providers
  async getProviders(): Promise<any[]> {
    const data = await this.request<{ providers: any[] }>("/providers");
    return data.providers;
  }

  async addProviderCredential(providerId: string, credential: string): Promise<void> {
    await this.request("/providers", {
      method: "POST",
      body: JSON.stringify({ providerId, credential }),
    });
  }

  async removeProviderCredential(providerId: string): Promise<void> {
    await this.request(`/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
  }

  async checkProvidersHealth(): Promise<any> {
    return this.request("/providers/health", {
      method: "POST",
    });
  }

  // Session provider management
  async setSessionProvider(sessionName: string, providerId: string, fallback?: string[]): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionName)}/provider`, {
      method: "PUT",
      body: JSON.stringify({ providerId, fallback }),
    });
  }

  // Middleware management
  async getMiddlewares(): Promise<{ name: string; priority: number; enabled: boolean; hasIncoming: boolean; hasOutgoing: boolean }[]> {
    const data = await this.request<{ middlewares: { name: string; priority: number; enabled: boolean; hasIncoming: boolean; hasOutgoing: boolean }[] }>("/middleware");
    return data.middlewares;
  }

  async getMiddlewareChain(): Promise<{ name: string; priority: number; enabled: boolean }[]> {
    const data = await this.request<{ chain: { name: string; priority: number; enabled: boolean }[] }>("/middleware/chain");
    return data.chain;
  }

  async getMiddleware(name: string): Promise<{ name: string; priority: number; enabled: boolean; hasIncoming: boolean; hasOutgoing: boolean }> {
    return this.request(`/middleware/${encodeURIComponent(name)}`);
  }

  async enableMiddleware(name: string): Promise<void> {
    await this.request(`/middleware/${encodeURIComponent(name)}/enable`, {
      method: "POST",
    });
  }

  async disableMiddleware(name: string): Promise<void> {
    await this.request(`/middleware/${encodeURIComponent(name)}/disable`, {
      method: "POST",
    });
  }

  async setMiddlewarePriority(name: string, priority: number): Promise<void> {
    await this.request(`/middleware/${encodeURIComponent(name)}/priority`, {
      method: "PUT",
      body: JSON.stringify({ priority }),
    });
  }

  // Context provider management
  async getContextProviders(): Promise<{ name: string; priority: number; enabled: boolean }[]> {
    const data = await this.request<{ providers: { name: string; priority: number; enabled: boolean }[] }>("/middleware/context");
    return data.providers;
  }

  async getContextProvider(name: string): Promise<{ name: string; priority: number; enabled: boolean }> {
    return this.request(`/middleware/context/${encodeURIComponent(name)}`);
  }

  async enableContextProvider(name: string): Promise<void> {
    await this.request(`/middleware/context/${encodeURIComponent(name)}/enable`, {
      method: "POST",
    });
  }

  async disableContextProvider(name: string): Promise<void> {
    await this.request(`/middleware/context/${encodeURIComponent(name)}/disable`, {
      method: "POST",
    });
  }

  async setContextProviderPriority(name: string, priority: number): Promise<void> {
    await this.request(`/middleware/context/${encodeURIComponent(name)}/priority`, {
      method: "PUT",
      body: JSON.stringify({ priority }),
    });
  }
}

// Default singleton
export const client = new WoprClient();
