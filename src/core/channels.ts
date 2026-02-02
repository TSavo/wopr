/**
 * Channel Provider Registry
 *
 * Allows channel plugins (Discord, Slack, Telegram) to register themselves
 * so that other plugins (like P2P) can add protocol-level commands and
 * message parsers that work across all channels.
 *
 * Example: P2P plugin registers /friend command on all channel providers.
 */

import { logger } from "../logger.js";
import type { ChannelProvider } from "../types.js";

// Registry of channel providers
const channelProviders: Map<string, ChannelProvider> = new Map();

/**
 * Register a channel provider
 */
export function registerChannelProvider(provider: ChannelProvider): void {
  if (channelProviders.has(provider.id)) {
    logger.warn(`[channels] Replacing existing channel provider: ${provider.id}`);
  }
  channelProviders.set(provider.id, provider);
  logger.info(`[channels] Channel provider registered: ${provider.id}`);
}

/**
 * Unregister a channel provider
 */
export function unregisterChannelProvider(id: string): void {
  if (channelProviders.delete(id)) {
    logger.info(`[channels] Channel provider unregistered: ${id}`);
  }
}

/**
 * Get a specific channel provider by ID
 */
export function getChannelProvider(id: string): ChannelProvider | undefined {
  return channelProviders.get(id);
}

/**
 * Get all registered channel providers
 */
export function getChannelProviders(): ChannelProvider[] {
  return Array.from(channelProviders.values());
}

/**
 * List all channel provider IDs
 */
export function listChannelProviders(): string[] {
  return Array.from(channelProviders.keys());
}
