/**
 * Provider Registry & Management System
 *
 * Handles registration, discovery, resolution, and fallback logic
 * for multiple model providers.
 */

import {
  ModelProvider,
  ModelClient,
  ProviderConfig,
  ProviderCredentials,
  ResolvedProvider,
  ProviderRegistration,
} from "../types/provider.js";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * Provider Registry
 * Singleton that manages all available providers and their credentials
 */
export class ProviderRegistry {
  private providers = new Map<string, ProviderRegistration>();
  private credentials = new Map<string, ProviderCredentials>();
  private credentialsPath: string;
  private loadedCredentials = false;

  constructor() {
    this.credentialsPath = join(homedir(), ".wopr", "providers.json");
  }

  /**
   * Register a provider
   */
  register(provider: ModelProvider): void {
    logger.info(`[provider-registry] Registering: ${provider.id} (${provider.name})`);
    this.providers.set(provider.id, {
      provider,
      available: false,
      lastChecked: 0,
    });
    logger.info(`[provider-registry]   ✓ ${provider.id} registered. Total: ${this.providers.size}`);
  }

  /**
   * Load credentials from disk
   */
  async loadCredentials(): Promise<void> {
    if (this.loadedCredentials) return;

    try {
      if (!existsSync(this.credentialsPath)) {
        this.loadedCredentials = true;
        return;
      }

      const data = await readFile(this.credentialsPath, "utf-8");
      const creds = JSON.parse(data) as ProviderCredentials[];

      for (const cred of creds) {
        this.credentials.set(cred.providerId, cred);
      }

      this.loadedCredentials = true;
    } catch (error) {
      logger.error(`Failed to load provider credentials: ${error}`);
      this.loadedCredentials = true;
    }
  }

  /**
   * Save credentials to disk
   */
  async saveCredentials(): Promise<void> {
    const creds = Array.from(this.credentials.values());

    // Ensure directory exists
    const dir = join(homedir(), ".wopr");
    await (await import("fs")).promises.mkdir(dir, { recursive: true });

    await writeFile(this.credentialsPath, JSON.stringify(creds, null, 2));
  }

  /**
   * Get a credential for a provider
   */
  getCredential(providerId: string): ProviderCredentials | undefined {
    return this.credentials.get(providerId);
  }

  /**
   * Store a credential
   */
  async setCredential(
    providerId: string,
    credential: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    // Validate provider exists
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not registered: ${providerId}`);
    }

    // Validate credential
    const valid = await provider.provider.validateCredentials(credential);
    if (!valid) {
      throw new Error(`Invalid credential for provider: ${providerId}`);
    }

    // Store credential
    this.credentials.set(providerId, {
      providerId,
      type: provider.provider.getCredentialType(),
      credential,
      metadata: metadata as any,
      createdAt: Date.now(),
    });

    // Save to disk
    await this.saveCredentials();
  }

  /**
   * Remove a credential
   */
  async removeCredential(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
    await this.saveCredentials();
  }

  /**
   * List all registered providers
   */
  listProviders(): Array<{ id: string; name: string; available: boolean }> {
    return Array.from(this.providers.values()).map((reg) => ({
      id: reg.provider.id,
      name: reg.provider.name,
      available: reg.available,
    }));
  }

  /**
   * Check health of all providers
   */
  async checkHealth(): Promise<void> {
    logger.info(`[provider-registry] Checking health for ${this.providers.size} providers`);
    const checks = Array.from(this.providers.values()).map(async (reg) => {
      try {
        logger.info(`[provider-registry] Checking ${reg.provider.id}...`);
        const cred = this.credentials.get(reg.provider.id);
        const credType = reg.provider.getCredentialType?.() || "api-key";
        logger.info(`[provider-registry] ${reg.provider.id}: credType=${credType}, hasCred=${!!cred}`);
        
        // For OAuth providers, skip credential check
        if (!cred && credType !== "oauth") {
          reg.available = false;
          reg.error = "No credentials configured";
          logger.info(`[provider-registry] ${reg.provider.id}: skipped - no credentials`);
          return;
        }

        logger.info(`[provider-registry] ${reg.provider.id}: creating client...`);
        const client = await reg.provider.createClient(cred?.credential || "");
        logger.info(`[provider-registry] ${reg.provider.id}: running health check...`);
        const healthy = await client.healthCheck();
        logger.info(`[provider-registry] ${reg.provider.id}: health check result=${healthy}`);

        reg.available = healthy;
        reg.lastChecked = Date.now();
        if (!healthy) {
          reg.error = "Health check failed";
        } else {
          reg.error = undefined;
        }
      } catch (error) {
        logger.error(`[provider-registry] ${reg.provider.id}: health check error:`, error);
        reg.available = false;
        reg.lastChecked = Date.now();
        reg.error = error instanceof Error ? error.message : "Unknown error";
      }
    });

    await Promise.all(checks);
    logger.info(`[provider-registry] Health check complete`);
  }

  /**
   * Resolve a provider with fallback chain
   * Returns the first available provider in the chain
   */
  async resolveProvider(config: ProviderConfig): Promise<ResolvedProvider> {
    const chain = [config.name, ...(config.fallback || [])];
    const errors: string[] = [];

    for (const providerName of chain) {
      const reg = this.providers.get(providerName);
      if (!reg) {
        errors.push(`Provider not found: ${providerName}`);
        continue;
      }

      const cred = this.credentials.get(providerName);
      const credType = reg.provider.getCredentialType?.() || "api-key";
      
      // For OAuth providers, skip credential check
      if (!cred && credType !== "oauth") {
        errors.push(`No credentials for provider: ${providerName}`);
        continue;
      }

      try {
        const client = await reg.provider.createClient(cred?.credential || "", config.options);
        return {
          name: providerName,
          provider: reg.provider,
          client,
          credential: cred?.credential || "",
          fallbackChain: chain.slice(chain.indexOf(providerName) + 1),
        };
      } catch (error) {
        errors.push(
          `Failed to create client for ${providerName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new Error(`Could not resolve any provider in chain [${chain.join(", ")}]:\n${errors.join("\n")}`);
  }

  /**
   * Get singleton instance
   */
  private static instance: ProviderRegistry;

  static getInstance(): ProviderRegistry {
    if (!this.instance) {
      this.instance = new ProviderRegistry();
    }
    return this.instance;
  }
}

/**
 * Export singleton
 */
export const providerRegistry = ProviderRegistry.getInstance();
