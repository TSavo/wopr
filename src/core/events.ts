/**
 * WOPR Event Bus - Core primitive for plugin event communication
 * 
 * The WOPR way: Expose the event primitive, let plugins compose.
 * This is a typed event bus that allows plugins to:
 * - Subscribe to core lifecycle events
 * - Emit custom events for inter-plugin communication
 * - Build reactive behaviors
 */

import { EventEmitter } from "events";
import { logger } from "../logger.js";

// ============================================================================
// Core Event Types
// ============================================================================

export interface WOPREvent {
  type: string;
  payload: any;
  timestamp: number;
  source?: string; // Plugin name that emitted, or "core"
}

// Session lifecycle events
export interface SessionCreateEvent {
  session: string;
  config?: any;
}

export interface SessionInjectEvent {
  session: string;
  message: string;
  from: string;
  channel?: { type: string; id: string; name?: string };
}

export interface SessionResponseEvent {
  session: string;
  message: string;
  response: string;
  from: string;
}

export interface SessionDestroyEvent {
  session: string;
  history: any[];
  reason?: string;
}

// Channel events
export interface ChannelMessageEvent {
  channel: { type: string; id: string; name?: string };
  message: string;
  from: string;
  metadata?: any;
}

export interface ChannelSendEvent {
  channel: { type: string; id: string };
  content: string;
}

// Plugin events
export interface PluginInitEvent {
  plugin: string;
  version: string;
}

export interface PluginErrorEvent {
  plugin: string;
  error: Error;
  context?: string;
}

// Config events
export interface ConfigChangeEvent {
  key: string;
  oldValue: any;
  newValue: any;
  plugin?: string;
}

// System events
export interface SystemShutdownEvent {
  reason: string;
  code?: number;
}

// ============================================================================
// Event Map - defines all core events and their payloads
// ============================================================================

export interface WOPREventMap {
  // Session lifecycle
  "session:create": SessionCreateEvent;
  "session:beforeInject": SessionInjectEvent;
  "session:afterInject": SessionResponseEvent;
  "session:responseChunk": SessionResponseEvent & { chunk: string };
  "session:destroy": SessionDestroyEvent;

  // Channel events
  "channel:message": ChannelMessageEvent;
  "channel:send": ChannelSendEvent;

  // Plugin lifecycle
  "plugin:beforeInit": PluginInitEvent;
  "plugin:afterInit": PluginInitEvent;
  "plugin:error": PluginErrorEvent;

  // Config changes
  "config:change": ConfigChangeEvent;

  // System events
  "system:shutdown": SystemShutdownEvent;

  // Wildcard - catch all
  "*": WOPREvent;
}

// ============================================================================
// Event Bus Interface
// ============================================================================

export type EventHandler<T = any> = (payload: T, event: WOPREvent) => void | Promise<void>;

export interface WOPREventBus {
  /**
   * Subscribe to an event
   * @param event - Event name (e.g., 'session:create')
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  on<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): () => void;

  /**
   * Subscribe to an event once
   * @param event - Event name
   * @param handler - Handler function
   */
  once<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): void;

  /**
   * Unsubscribe from an event
   * @param event - Event name
   * @param handler - Handler function to remove
   */
  off<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): void;

  /**
   * Emit an event
   * @param event - Event name
   * @param payload - Event payload
   * @param source - Source plugin or "core"
   */
  emit<T extends keyof WOPREventMap>(
    event: T,
    payload: WOPREventMap[T],
    source?: string
  ): Promise<void>;

  /**
   * Emit a custom event (for inter-plugin communication)
   * @param event - Custom event name (use plugin: prefix)
   * @param payload - Event payload
   * @param source - Source plugin
   */
  emitCustom(
    event: string,
    payload: any,
    source?: string
  ): Promise<void>;

  /**
   * Get list of all active event listeners
   */
  listenerCount(event: string): number;

  /**
   * Remove all listeners for an event
   */
  removeAllListeners(event?: string): void;
}

// ============================================================================
// Event Bus Implementation
// ============================================================================

class WOPREventBusImpl implements WOPREventBus {
  private emitter = new EventEmitter();
  private handlerWrappers = new WeakMap<Function, Function>();

  on<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): () => void {
    // Wrap handler to provide full event context
    const wrapper = async (payload: any, meta: { timestamp: number; source?: string }) => {
      const fullEvent: WOPREvent = {
        type: event as string,
        payload,
        timestamp: meta?.timestamp || Date.now(),
        source: meta?.source || "unknown",
      };

      try {
        await handler(payload, fullEvent);
      } catch (err) {
        logger.error(`[events] Handler error for ${event}:`, err);
      }
    };

    this.handlerWrappers.set(handler, wrapper);
    this.emitter.on(event as string, wrapper);

    // Return unsubscribe function
    return () => this.off(event, handler);
  }

  once<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): void {
    const wrapper = async (payload: any, meta: { timestamp: number; source?: string }) => {
      const fullEvent: WOPREvent = {
        type: event as string,
        payload,
        timestamp: meta?.timestamp || Date.now(),
        source: meta?.source || "unknown",
      };

      try {
        await handler(payload, fullEvent);
      } catch (err) {
        logger.error(`[events] Handler error for ${event}:`, err);
      }
    };

    this.emitter.once(event as string, wrapper);
  }

  off<T extends keyof WOPREventMap>(
    event: T,
    handler: EventHandler<WOPREventMap[T]>
  ): void {
    const wrapper = this.handlerWrappers.get(handler);
    if (wrapper) {
      this.emitter.off(event as string, wrapper as (...args: any[]) => void);
      this.handlerWrappers.delete(handler);
    }
  }

  async emit<T extends keyof WOPREventMap>(
    event: T,
    payload: WOPREventMap[T],
    source: string = "core"
  ): Promise<void> {
    const meta = { timestamp: Date.now(), source };
    
    // Emit specific event
    this.emitter.emit(event as string, payload, meta);

    // Also emit wildcard event for catch-all listeners
    const wildcardEvent: WOPREvent = {
      type: event as string,
      payload,
      timestamp: meta.timestamp,
      source,
    };
    this.emitter.emit("*", wildcardEvent, meta);

    logger.debug(`[events] Emitted: ${event as string} (source: ${source})`);
  }

  async emitCustom(
    event: string,
    payload: any,
    source: string = "unknown"
  ): Promise<void> {
    // Validate custom event name (suggest plugin: prefix)
    if (!event.includes(":")) {
      logger.warn(`[events] Custom event '${event}' should use 'plugin:' prefix (e.g., 'myplugin:customEvent')`);
    }

    await this.emit(event as keyof WOPREventMap, payload, source);
  }

  listenerCount(event: string): number {
    return this.emitter.listenerCount(event);
  }

  removeAllListeners(event?: string): void {
    this.emitter.removeAllListeners(event);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const eventBus: WOPREventBus = new WOPREventBusImpl();

// ============================================================================
// Convenience Exports for Core Usage
// ============================================================================

export async function emitSessionCreate(session: string, config?: any): Promise<void> {
  await eventBus.emit("session:create", { session, config }, "core");
}

export async function emitSessionBeforeInject(
  session: string,
  message: string,
  from: string,
  channel?: { type: string; id: string; name?: string }
): Promise<void> {
  await eventBus.emit("session:beforeInject", { session, message, from, channel }, "core");
}

export async function emitSessionAfterInject(
  session: string,
  message: string,
  response: string,
  from: string
): Promise<void> {
  await eventBus.emit("session:afterInject", { session, message, response, from }, "core");
}

export async function emitSessionResponseChunk(
  session: string,
  message: string,
  response: string,
  from: string,
  chunk: string
): Promise<void> {
  await eventBus.emit("session:responseChunk", { session, message, response, from, chunk }, "core");
}

export async function emitSessionDestroy(session: string, history: any[], reason?: string): Promise<void> {
  await eventBus.emit("session:destroy", { session, history, reason }, "core");
}

export async function emitChannelMessage(
  channel: { type: string; id: string; name?: string },
  message: string,
  from: string,
  metadata?: any
): Promise<void> {
  await eventBus.emit("channel:message", { channel, message, from, metadata }, "core");
}

export async function emitChannelSend(
  channel: { type: string; id: string },
  content: string
): Promise<void> {
  await eventBus.emit("channel:send", { channel, content }, "core");
}

export async function emitPluginBeforeInit(plugin: string, version: string): Promise<void> {
  await eventBus.emit("plugin:beforeInit", { plugin, version }, "core");
}

export async function emitPluginAfterInit(plugin: string, version: string): Promise<void> {
  await eventBus.emit("plugin:afterInit", { plugin, version }, "core");
}

export async function emitPluginError(plugin: string, error: Error, context?: string): Promise<void> {
  await eventBus.emit("plugin:error", { plugin, error, context }, "core");
}

export async function emitConfigChange(
  key: string,
  oldValue: any,
  newValue: any,
  plugin?: string
): Promise<void> {
  await eventBus.emit("config:change", { key, oldValue, newValue, plugin }, "core");
}

export async function emitSystemShutdown(reason: string, code?: number): Promise<void> {
  await eventBus.emit("system:shutdown", { reason, code }, "core");
}

// ============================================================================
// Mutable Event Helpers (for hook-based message transformation)
// ============================================================================

/**
 * Mutable incoming message event result
 */
export interface MutableIncomingResult {
  message: string;
  prevented: boolean;
}

/**
 * Mutable outgoing response event result
 */
export interface MutableOutgoingResult {
  response: string;
  prevented: boolean;
}

/**
 * Emit an incoming message event that hooks can transform or block.
 * Replaces the old middleware pattern with hooks.
 *
 * @returns The (possibly transformed) message and whether it was blocked
 */
export async function emitMutableIncoming(
  session: string,
  message: string,
  from: string,
  channel?: { type: string; id: string; name?: string }
): Promise<MutableIncomingResult> {
  // Create mutable payload that hooks can modify
  const mutablePayload = {
    session,
    message,
    from,
    channel,
    _prevented: false,
  };

  // Emit the event - handlers can mutate mutablePayload
  await eventBus.emit("session:beforeInject", mutablePayload as any, "core");

  return {
    message: mutablePayload.message,
    prevented: mutablePayload._prevented,
  };
}

/**
 * Emit an outgoing response event that hooks can transform or block.
 * Replaces the old middleware pattern with hooks.
 *
 * @returns The (possibly transformed) response and whether it was blocked
 */
export async function emitMutableOutgoing(
  session: string,
  response: string,
  from: string,
  channel?: { type: string; id: string; name?: string }
): Promise<MutableOutgoingResult> {
  // Create mutable payload that hooks can modify
  const mutablePayload = {
    session,
    response,
    from,
    channel,
    _prevented: false,
  };

  // Emit the event - handlers can mutate mutablePayload
  await eventBus.emit("session:afterInject", mutablePayload as any, "core");

  return {
    response: mutablePayload.response,
    prevented: mutablePayload._prevented,
  };
}
