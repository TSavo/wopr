/**
 * Kimi Provider
 *
 * Implements the ModelProvider interface for Moonshot AI's Kimi Code CLI Agent SDK
 */

import {
  ModelProvider,
  ModelClient,
  ModelQueryOptions,
  ModelResponse,
} from "../types/provider.js";

let KimiSDK: any;

/**
 * Lazy load Kimi Agent SDK
 */
async function loadKimiSDK() {
  if (!KimiSDK) {
    try {
      // Dynamic import to avoid hard dependency
      const kimi = await import("@moonshot-ai/kimi-agent-sdk" as string);
      KimiSDK = kimi;
    } catch (error) {
      throw new Error(
        'Kimi Agent SDK not installed. Run: npm install @moonshot-ai/kimi-agent-sdk'
      );
    }
  }
  return KimiSDK;
}

/**
 * Kimi provider implementation
 * Uses the Kimi Agent SDK for agent-based code execution
 */
export const kimiProvider: ModelProvider = {
  id: "kimi",
  name: "Kimi",
  description: "Moonshot AI Kimi Code CLI agent SDK for coding tasks (image URLs passed in prompt)",
  defaultModel: "kimi-k2",
  supportedModels: ["kimi-k2", "kimi-for-coding"],

  async validateCredentials(credential: string): Promise<boolean> {
    // API key format: sk-... (Moonshot format)
    if (!credential.startsWith("sk-")) {
      return false;
    }

    try {
      const kimi = await loadKimiSDK();
      // Create a client to validate the credential
      const agent = new kimi.KimiAgent({ apiKey: credential });
      // Try a simple health check via creating a session
      const session = await agent.createSession();
      await session.close();
      return true;
    } catch (error) {
      return false;
    }
  },

  async createClient(
    credential: string,
    options?: Record<string, unknown>
  ): Promise<ModelClient> {
    return new KimiClient(credential, options);
  },

  getCredentialType(): "api-key" | "oauth" | "custom" {
    return "api-key";
  },
};

/**
 * Kimi client implementation
 * Wraps the Kimi Agent SDK
 */
class KimiClient implements ModelClient {
  private agent: any;

  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {
    // Set API key for Kimi SDK to use
    process.env.MOONSHOT_API_KEY = credential;
  }

  private async getAgent() {
    if (!this.agent) {
      const kimi = await loadKimiSDK();
      this.agent = new kimi.KimiAgent({
        apiKey: this.credential,
        ...this.options,
      });
    }
    return this.agent;
  }

  async *query(opts: ModelQueryOptions): AsyncGenerator<any> {
    const agent = await this.getAgent();

    try {
      // Create a session (pass sessionId to resume if provided)
      const sessionOptions: any = {};
      if (opts.resume) {
        sessionOptions.sessionId = opts.resume;
      }
      const session = await agent.createSession(sessionOptions);

      // Prepare prompt - include image URLs in text
      let prompt = opts.prompt;
      if (opts.images && opts.images.length > 0) {
        const imageList = opts.images.map((url, i) => `[Image ${i + 1}]: ${url}`).join('\n');
        prompt = `[User has shared ${opts.images.length} image(s)]\n${imageList}\n\n${opts.prompt}`;
      }

      // Add system prompt if provided
      if (opts.systemPrompt) {
        prompt = `${opts.systemPrompt}\n\n${prompt}`;
      }

      // Run the query
      const stream = await session.sendMessage(prompt);

      // Stream results from Kimi agent
      for await (const msg of stream) {
        // Normalize Kimi SDK format to our StreamMessage format
        if (msg.type === "text" || msg.type === "assistant") {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: msg.content || msg.text || "" }],
            },
          };
        } else if (msg.type === "tool_use" || msg.type === "tool_call") {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", name: msg.name || msg.tool_name }],
            },
          };
        } else if (msg.type === "complete" || msg.type === "done") {
          yield {
            type: "result",
            subtype: "success",
            total_cost_usd: msg.cost || 0,
          };
        } else if (msg.type === "error") {
          yield {
            type: "result",
            subtype: "error",
            error: msg.error || msg.message,
          };
        } else {
          // Pass through unknown message types
          yield msg;
        }
      }

      // Close the session
      await session.close();
    } catch (error) {
      throw new Error(
        `Kimi query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listModels(): Promise<string[]> {
    return kimiProvider.supportedModels;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const agent = await this.getAgent();
      const session = await agent.createSession();
      await session.close();
      return true;
    } catch {
      return false;
    }
  }
}
