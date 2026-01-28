/**
 * Unified Query Interface
 *
 * Provides a single interface for querying models regardless of provider.
 * Handles provider resolution, fallback, and response normalization.
 */

import { providerRegistry } from "./providers.js";
import {
  ProviderConfig,
  ModelQueryOptions,
  ModelResponse,
} from "../types/provider.js";

/**
 * Query options normalized from session context
 */
export interface QueryRequest {
  prompt: string;
  systemPrompt?: string;
  sessionId?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  providerConfig?: ProviderConfig;
  providerOptions?: Record<string, unknown>;
}

/**
 * Execute a query with automatic provider resolution and fallback
 *
 * @param request Query request with all parameters
 * @returns Model response from first successful provider
 * @throws Error if all providers in fallback chain fail
 */
export async function executeQuery(request: QueryRequest): Promise<ModelResponse> {
  // Use provided config or auto-detect available provider
  let config: ProviderConfig;
  if (request.providerConfig) {
    config = request.providerConfig;
  } else {
    // Auto-detect: use first available provider
    const available = providerRegistry.listProviders().filter(p => p.available);
    if (available.length === 0) {
      throw new Error("No providers available. Configure at least one provider (anthropic, kimi, openai, etc.)");
    }
    config = { name: available[0].id };
    console.log(`[Query] Auto-selected provider: ${available[0].id}`);
  }

  try {
    // Resolve provider with fallback
    const resolved = await providerRegistry.resolveProvider(config);

    // Prepare query options
    const options: ModelQueryOptions = {
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      resume: request.sessionId,
      model: request.model || config.model,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      topP: request.topP,
      providerOptions: request.providerOptions || config.options,
    };

    // Execute query (returns async generator for streaming)
    const stream = resolved.client.query(options);

    // Collect all chunks to build final response
    const chunks: string[] = [];
    let sessionId: string | undefined;
    let providerUsed = resolved.provider.id;
    let modelUsed = options.model || resolved.provider.defaultModel;

    for await (const msg of stream) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
      } else if (msg.type === "assistant") {
        for (const block of msg.message?.content || []) {
          if (block.type === "text") {
            chunks.push(block.text);
          }
        }
      }
    }

    console.log(`[Query] Used provider: ${providerUsed} (${modelUsed})`);

    return {
      content: chunks.join(""),
      provider: providerUsed,
      model: modelUsed,
      sessionId,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Query] Failed: ${errorMsg}`);
    throw error;
  }
}

/**
 * List available models across all configured providers
 */
export async function listAvailableModels(): Promise<
  Array<{ provider: string; models: string[] }>
> {
  const providers = providerRegistry.listProviders();
  const result = [];

  for (const providerInfo of providers) {
    if (!providerInfo.available) continue;

    try {
      const resolved = await providerRegistry.resolveProvider({
        name: providerInfo.id,
      });

      const models = await resolved.client.listModels();
      result.push({
        provider: providerInfo.name,
        models,
      });
    } catch (error) {
      console.warn(`Failed to list models for ${providerInfo.id}`);
    }
  }

  return result;
}

/**
 * Get health status of all configured providers
 */
export function getProviderStatus(): Array<{
  id: string;
  name: string;
  available: boolean;
  lastChecked: number;
}> {
  return providerRegistry.listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    available: p.available,
    lastChecked: 0, // TODO: track this in registry
  }));
}
