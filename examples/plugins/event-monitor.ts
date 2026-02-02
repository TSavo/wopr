/**
 * WOPR Event Monitor Plugin Example
 * 
 * This plugin demonstrates the event bus and hooks API.
 * It monitors session lifecycle, channel messages, and emits custom events.
 * 
 * Usage:
 *   Add to your WOPR plugins and see events logged to console.
 */

import type { WOPRPlugin, WOPRPluginContext } from "../../src/types.js";

const plugin: WOPRPlugin = {
  name: "event-monitor",
  version: "1.0.0",
  description: "Example plugin demonstrating event bus and hooks API",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("[event-monitor] Initializing...");

    // ============================================================================
    // Event Bus - Reactive Primitive
    // ============================================================================

    // Listen to session creation
    const unsubCreate = ctx.events.on("session:create", (event) => {
      ctx.log.info(`[event-monitor] Session created: ${event.session}`);
      if (event.config) {
        ctx.log.debug(`[event-monitor]   Config:`, event.config);
      }
    });

    // Listen to beforeInject (can be used for analytics, logging, etc.)
    const unsubBeforeInject = ctx.events.on("session:beforeInject", (event) => {
      ctx.log.info(`[event-monitor] Before inject: ${event.session}`);
      ctx.log.info(`[event-monitor]   From: ${event.from}`);
      ctx.log.info(`[event-monitor]   Message: ${event.message.substring(0, 50)}...`);
      if (event.channel) {
        ctx.log.info(`[event-monitor]   Channel: ${event.channel.type}:${event.channel.id}`);
      }
    });

    // Listen to response chunks (streaming)
    const unsubChunk = ctx.events.on("session:responseChunk", (event) => {
      ctx.log.debug(`[event-monitor] Response chunk from ${event.session}: ${event.chunk.substring(0, 30)}...`);
    });

    // Listen to afterInject (final response)
    const unsubAfterInject = ctx.events.on("session:afterInject", (event) => {
      ctx.log.info(`[event-monitor] After inject: ${event.session}`);
      ctx.log.info(`[event-monitor]   Response length: ${event.response.length} chars`);
    });

    // Listen to session destruction
    const unsubDestroy = ctx.events.on("session:destroy", (event) => {
      ctx.log.info(`[event-monitor] Session destroyed: ${event.session}`);
      ctx.log.info(`[event-monitor]   History entries: ${event.history.length}`);
      if (event.reason) {
        ctx.log.info(`[event-monitor]   Reason: ${event.reason}`);
      }
    });

    // Listen to channel messages
    const unsubChannel = ctx.events.on("channel:message", (event) => {
      ctx.log.info(`[event-monitor] Channel message: ${event.channel.type}:${event.channel.id}`);
      ctx.log.info(`[event-monitor]   From: ${event.from}`);
      ctx.log.info(`[event-monitor]   Message: ${event.message.substring(0, 50)}...`);
    });

    // Subscribe once to a specific session creation
    ctx.events.once("session:create", (event) => {
      ctx.log.info(`[event-monitor] ONCE - First session created: ${event.session}`);
    });

    // Catch-all listener using wildcard
    const unsubWildcard = ctx.events.on("*", (event) => {
      ctx.log.debug(`[event-monitor] [WILDCARD] ${event.type} at ${new Date(event.timestamp).toISOString()}`);
    });

    // ============================================================================
    // Hooks - Typed, Mutable Event Handlers
    // ============================================================================

    // Hook into beforeInject to modify messages
    const hookBefore = ctx.hooks.on("session:beforeInject", async (event) => {
      // This hook can modify the message before it goes to the LLM
      const originalMessage = event.data.message;
      
      // Example: Add a prefix to all messages (uncomment to enable)
      // event.data.message = `[MONITORED] ${originalMessage}`;
      
      ctx.log.debug(`[event-monitor] [HOOK] beforeInject - can modify message`);
      
      // Example: Prevent certain messages (uncomment to enable)
      // if (originalMessage.includes("secret")) {
      //   event.preventDefault();
      //   ctx.log.warn(`[event-monitor] [HOOK] Blocked message containing 'secret'`);
      // }
    });

    // Hook into afterInject for read-only analytics
    const hookAfter = ctx.hooks.on("session:afterInject", (event) => {
      ctx.log.debug(`[event-monitor] [HOOK] afterInject - read-only`);
      // Could send to analytics service here
    });

    // ============================================================================
    // Custom Events - Inter-Plugin Communication
    // ============================================================================

    // Emit a custom event (use plugin: prefix convention)
    await ctx.events.emitCustom("event-monitor:initialized", {
      timestamp: Date.now(),
      version: "1.0.0",
    });

    // Listen to custom events from other plugins
    const unsubCustom = ctx.events.on("event-monitor:initialized", (event) => {
      ctx.log.info(`[event-monitor] Another instance initialized:`, event);
    });

    // ============================================================================
    // Event Listener Management
    // ============================================================================

    // Get listener count
    const beforeInjectListeners = ctx.events.listenerCount("session:beforeInject");
    ctx.log.info(`[event-monitor] beforeInject listeners: ${beforeInjectListeners}`);

    // Store unsubs for cleanup
    ctx.config.set?.("unsubs", [
      unsubCreate,
      unsubBeforeInject,
      unsubChunk,
      unsubAfterInject,
      unsubDestroy,
      unsubChannel,
      unsubWildcard,
      unsubCustom,
    ]);

    ctx.log.info("[event-monitor] Initialized successfully!");
  },

  async destroy(ctx: WOPRPluginContext) {
    ctx.log.info("[event-monitor] Destroying...");

    // Cleanup: call all unsubscribe functions
    const unsubs = ctx.config.get?.("unsubs") as Array<() => void> | undefined;
    if (unsubs) {
      unsubs.forEach((unsub, i) => {
        try {
          unsub();
          ctx.log.debug(`[event-monitor] Unsubscribed handler ${i + 1}`);
        } catch (err) {
          ctx.log.error(`[event-monitor] Error unsubscribing handler ${i + 1}:`, err);
        }
      });
    }

    ctx.log.info("[event-monitor] Destroyed successfully!");
  },
};

export default plugin;
