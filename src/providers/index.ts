/**
 * Provider Registry Initialization
 *
 * Registers all available providers and exports setup function
 */

import { providerRegistry } from "../core/providers.js";
import { anthropicProvider } from "./anthropic.js";
import { codexProvider } from "./openai.js";
import { kimiProvider } from "./kimi.js";
import { opencodeProvider } from "./opencode.js";

/**
 * Initialize the provider system
 * Call this during daemon startup
 */
export async function initializeProviders(): Promise<void> {
  // Register built-in providers
  providerRegistry.register(anthropicProvider);
  providerRegistry.register(codexProvider);

  // Load persisted credentials
  await providerRegistry.loadCredentials();

  // Check health of all providers
  await providerRegistry.checkHealth();
}

/**
 * Export registry and providers
 */
export { providerRegistry };
export { anthropicProvider };
export { codexProvider };
export { kimiProvider };
export { opencodeProvider };

// Export types
export type {
  ModelProvider,
  ModelClient,
  ModelQueryOptions,
  ModelResponse,
  ProviderConfig,
  ProviderCredentials,
  ResolvedProvider,
} from "../types/provider.js";
