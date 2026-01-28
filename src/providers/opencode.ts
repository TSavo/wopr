/**
 * OpenCode Provider
 *
 * Implements the ModelProvider interface for the OpenCode SDK
 * OpenCode is an open-source AI coding assistant
 */

import {
  ModelProvider,
  ModelClient,
  ModelQueryOptions,
  ModelResponse,
} from "../types/provider.js";

let OpencodeSDK: any;

/**
 * Lazy load OpenCode SDK
 */
async function loadOpencodeSDK() {
  if (!OpencodeSDK) {
    try {
      const opencode = await import("@opencode-ai/sdk" as string);
      OpencodeSDK = opencode;
    } catch (error) {
      throw new Error(
        'OpenCode SDK not installed. Run: npm install @opencode-ai/sdk'
      );
    }
  }
  return OpencodeSDK;
}

/**
 * OpenCode provider implementation
 * Uses the OpenCode SDK for agent-based code execution
 */
export const opencodeProvider: ModelProvider = {
  id: "opencode",
  name: "OpenCode",
  description: "OpenCode AI SDK for coding tasks (image URLs passed in prompt)",
  defaultModel: "claude-3-5-sonnet",
  supportedModels: [
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "gpt-4o",
    "gpt-4o-mini",
  ],

  async validateCredentials(credential: string): Promise<boolean> {
    // OpenCode uses its own config, credential is optional (uses opencode.json)
    // For validation, we just check if we can create a client
    try {
      const opencode = await loadOpencodeSDK();
      // Try to create a client - if it fails, credentials are invalid
      const client = opencode.createOpencodeClient({
        baseUrl: credential || "http://localhost:4096",
      });
      // Try a health check
      const health = await client.global.health();
      return health.data?.healthy === true;
    } catch (error) {
      // If we can't connect, we assume the user needs to start the server
      return true; // Allow anyway, server might not be running yet
    }
  },

  async createClient(
    credential: string,
    options?: Record<string, unknown>
  ): Promise<ModelClient> {
    return new OpencodeClient(credential, options);
  },

  getCredentialType(): "api-key" | "oauth" | "custom" {
    return "custom"; // OpenCode uses server-based auth
  },
};

/**
 * OpenCode client implementation
 * Wraps the OpenCode SDK
 */
class OpencodeClient implements ModelClient {
  private client: any;
  private sessionId: string | null = null;

  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {}

  private async getClient() {
    if (!this.client) {
      const opencode = await loadOpencodeSDK();
      this.client = opencode.createOpencodeClient({
        baseUrl: this.credential || "http://localhost:4096",
        ...this.options,
      });
    }
    return this.client;
  }

  async *query(opts: ModelQueryOptions): AsyncGenerator<any> {
    const client = await this.getClient();

    try {
      // Create a session if we don't have one
      if (!this.sessionId) {
        const session = await client.session.create({
          body: { 
            title: `WOPR Session ${Date.now()}`,
          },
        });
        this.sessionId = session.data?.id;
      }

      if (!this.sessionId) {
        throw new Error("Failed to create OpenCode session");
      }

      // Prepare prompt - include image URLs in text
      let promptText = opts.prompt;
      if (opts.images && opts.images.length > 0) {
        const imageList = opts.images.map((url, i) => `[Image ${i + 1}]: ${url}`).join('\n');
        promptText = `[User has shared ${opts.images.length} image(s)]\n${imageList}\n\n${opts.prompt}`;
      }

      // Build parts array
      const parts: any[] = [{ type: "text", text: promptText }];

      // Send the prompt
      const result = await client.session.prompt({
        path: { id: this.sessionId },
        body: {
          model: opts.model 
            ? { providerID: "anthropic", modelID: opts.model }
            : { providerID: "anthropic", modelID: opencodeProvider.defaultModel },
          parts,
        },
      });

      // Stream the response
      // OpenCode returns the full response, we need to simulate streaming
      if (result.data) {
        const parts = result.data.parts || [];
        
        for (const part of parts) {
          if (part.type === "text") {
            yield {
              type: "assistant",
              message: {
                content: [{ type: "text", text: part.text }],
              },
            };
          } else if (part.type === "tool_use" || part.type === "tool_call") {
            yield {
              type: "assistant",
              message: {
                content: [{ type: "tool_use", name: part.name }],
              },
            };
          }
        }

        // Yield completion
        yield {
          type: "result",
          subtype: "success",
          total_cost_usd: 0, // OpenCode doesn't expose cost
        };
      }
    } catch (error) {
      throw new Error(
        `OpenCode query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listModels(): Promise<string[]> {
    return opencodeProvider.supportedModels;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const health = await client.global.health();
      return health.data?.healthy === true;
    } catch {
      return false;
    }
  }
}
