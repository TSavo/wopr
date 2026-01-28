/**
 * Multi-Provider Architecture for WOPR
 *
 * Defines the abstraction layer for pluggable model providers.
 * Supports fallback chains, per-session provider selection, and
 * standardized credential management.
 */

/**
 * Provider configuration for a session
 * Specifies which provider to use and fallback chain
 */
export interface ProviderConfig {
  /** Primary provider name: "anthropic" | "openai" | "kilo" | custom */
  name: string;

  /** Optional model override for this session */
  model?: string;

  /** Fallback providers if primary fails: ["openai", "anthropic"] */
  fallback?: string[];

  /** Provider-specific options (e.g., temperature, top_p) */
  options?: Record<string, unknown>;
}

/**
 * Credentials for a provider
 * Different providers use different credential types
 */
export interface ProviderCredentials {
  /** Provider ID */
  providerId: string;

  /** Credential type: "api-key" | "oauth" | "custom" */
  type: "api-key" | "oauth" | "custom";

  /** The actual credential (API key, token, etc.) */
  credential: string;

  /** Additional provider-specific data */
  metadata?: {
    expiresAt?: number;           // For OAuth tokens
    refreshToken?: string;        // For OAuth flows
    region?: string;              // For region-specific providers
    customKey?: string;           // For custom credentials
    [key: string]: unknown;
  };

  /** When this credential was added */
  createdAt: number;

  /** When this credential expires (if applicable) */
  expiresAt?: number;
}

/**
 * Request options for model queries
 * Normalized across all providers
 */
export interface ModelQueryOptions {
  /** The prompt/message to send */
  prompt: string;

  /** System prompt/context */
  systemPrompt?: string;

  /** For resuming existing sessions */
  resume?: string;

  /** Model name override */
  model?: string;

  /** Temperature for generation (0-2)*/
  temperature?: number;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Top-p sampling */
  topP?: number;

  /** Image URLs for vision models */
  images?: string[];

  /** Provider-specific options */
  providerOptions?: Record<string, unknown>;
}

/**
 * Response from a model provider
 * Normalized across all providers
 */
export interface ModelResponse {
  /** The generated text */
  content: string;

  /** Which provider generated this */
  provider: string;

  /** Which model was used */
  model: string;

  /** Tokens used (if provider reports it) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };

  /** Session ID for resuming (if provider supports it) */
  sessionId?: string;

  /** Stop reason (if reported) */
  stopReason?: string;

  /** Raw provider response (for debugging) */
  raw?: unknown;
}

/**
 * Client interface for interacting with a provider
 *
 * Note: query() returns an async generator for streaming support.
 * Agent SDKs (Claude Agent SDK, Codex SDK) naturally return generators
 * for streaming results as they become available.
 */
export interface ModelClient {
  /**
   * Execute a query against the model
   * Returns an async generator that yields streaming results
   */
  query(options: ModelQueryOptions): AsyncGenerator<any>;

  /**
   * List available models from this provider
   */
  listModels(): Promise<string[]>;

  /**
   * Health check - verify provider is accessible
   */
  healthCheck(): Promise<boolean>;
}

/**
 * Provider implementation interface
 * Each provider (Anthropic, OpenAI, etc.) implements this
 */
export interface ModelProvider {
  /** Unique ID: "anthropic" | "openai" | "kilo" */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of provider */
  description: string;

  /** Default model for this provider */
  defaultModel: string;

  /** Supported models */
  supportedModels: string[];

  /**
   * Validate that credentials are valid
   * Used before attempting to use provider
   */
  validateCredentials(credentials: string): Promise<boolean>;

  /**
   * Create a client instance with given credentials
   * @param credential The credential (API key, token, etc.)
   * @param options Optional provider-specific options
   */
  createClient(credential: string, options?: Record<string, unknown>): Promise<ModelClient>;

  /**
   * Get the credential type this provider expects
   */
  getCredentialType(): "api-key" | "oauth" | "custom";

  /**
   * Optional: Get OAuth configuration if provider supports it
   */
  getOAuthConfig?(): {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    authUrl: string;
    tokenUrl: string;
  } | null;
}

/**
 * Provider registration entry
 * Used internally by the registry
 */
export interface ProviderRegistration {
  provider: ModelProvider;
  available: boolean;           // Can we use this provider?
  lastChecked: number;          // When we last checked availability
  error?: string;               // Error message if not available
}

/**
 * Result of provider resolution with fallback
 */
export interface ResolvedProvider {
  name: string;
  provider: ModelProvider;
  client: ModelClient;
  credential: string;
  fallbackChain: string[];      // Remaining fallbacks
}
