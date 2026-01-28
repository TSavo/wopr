/**
 * Anthropic Claude Provider
 *
 * Implements the ModelProvider interface for Anthropic's Claude Agent SDK
 */

import {
  ModelProvider,
  ModelClient,
  ModelQueryOptions,
  ModelResponse,
} from "../types/provider.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Anthropic provider implementation
 * Uses the Claude Agent SDK for agent-based execution
 */
export const anthropicProvider: ModelProvider = {
  id: "anthropic",
  name: "Anthropic",
  description: "Anthropic Claude API via Agent SDK (Pay-per-use or Claude.ai OAuth)",
  defaultModel: "claude-opus-4-5-20251101",
  supportedModels: [
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-20250514",
    "claude-haiku-4-5-20251001",
  ],

  async validateCredentials(credential: string): Promise<boolean> {
    // API key format: sk-ant-...
    if (!credential.startsWith("sk-ant-")) {
      return false;
    }

    // Try a simple health check with the credential
    try {
      const oldKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = credential;

      // Try a minimal query to validate
      const response = await query({
        prompt: "ping",
        options: {
          max_tokens: 10,
        } as any,
      });

      process.env.ANTHROPIC_API_KEY = oldKey;
      return !!response;
    } catch (error) {
      return false;
    }
  },

  async createClient(
    credential: string,
    options?: Record<string, unknown>
  ): Promise<ModelClient> {
    return new AnthropicClient(credential, options);
  },

  getCredentialType(): "api-key" | "oauth" | "custom" {
    return "api-key";
  },
};

/**
 * Anthropic client implementation
 * Wraps the Claude Agent SDK query function
 */
class AnthropicClient implements ModelClient {
  constructor(
    private credential: string,
    private options?: Record<string, unknown>
  ) {
    // Set API key for Claude Agent SDK to use
    process.env.ANTHROPIC_API_KEY = credential;
  }

  async *query(opts: ModelQueryOptions): AsyncGenerator<any> {
    const model = opts.model || anthropicProvider.defaultModel;

    const queryOptions: any = {
      max_tokens: opts.maxTokens || 4096,
    };

    if (opts.systemPrompt) {
      queryOptions.systemPrompt = opts.systemPrompt;
    }

    if (opts.resume) {
      queryOptions.resume = opts.resume;
    }

    if (opts.temperature !== undefined) {
      queryOptions.temperature = opts.temperature;
    }

    if (opts.topP !== undefined) {
      queryOptions.topP = opts.topP;
    }

    // Merge provider-specific options
    if (opts.providerOptions) {
      Object.assign(queryOptions, opts.providerOptions);
    }

    try {
      // Use Claude Agent SDK query function - returns async generator
      const q = await query({
        prompt: opts.prompt,
        options: queryOptions,
      });

      // Stream results from agent SDK
      for await (const msg of q) {
        yield msg;
      }
    } catch (error) {
      throw new Error(
        `Anthropic query failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listModels(): Promise<string[]> {
    return anthropicProvider.supportedModels;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const oldKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = this.credential;

      // Try a minimal query
      const response = await query({
        prompt: "test",
        options: {
          max_tokens: 10,
        } as any,
      });

      process.env.ANTHROPIC_API_KEY = oldKey;
      return !!response;
    } catch {
      return false;
    }
  }
}
