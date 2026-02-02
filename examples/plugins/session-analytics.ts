/**
 * WOPR Session Analytics Plugin
 * 
 * Demonstrates building reactive systems on top of the event bus primitive.
 * Tracks session metrics, response times, and token usage.
 * 
 * Usage:
 *   Add to your WOPR plugins and see analytics logged.
 */

import type { WOPRPlugin, WOPRPluginContext } from "../../src/types.js";

interface SessionMetrics {
  messageCount: number;
  totalResponseLength: number;
  firstMessageAt: number;
  lastMessageAt: number;
}

interface PluginState {
  sessions: Map<string, SessionMetrics>;
  pendingInjects: Map<string, number>; // session -> start time
  totalMessages: number;
  totalSessions: number;
}

const plugin: WOPRPlugin = {
  name: "session-analytics",
  version: "1.0.0",
  description: "Session analytics and metrics tracking",

  async init(ctx: WOPRPluginContext) {
    ctx.log.info("[analytics] Initializing...");

    // Plugin state (could persist to disk in a real implementation)
    const state: PluginState = {
      sessions: new Map(),
      pendingInjects: new Map(),
      totalMessages: 0,
      totalSessions: 0,
    };

    // Store state in config for access from other methods
    (ctx.config as any).state = state;

    // ============================================================================
    // Reactive State Building
    // ============================================================================

    // When a session is created, initialize its metrics
    ctx.events.on("session:create", (event) => {
      const metrics: SessionMetrics = {
        messageCount: 0,
        totalResponseLength: 0,
        firstMessageAt: Date.now(),
        lastMessageAt: Date.now(),
      };
      
      state.sessions.set(event.session, metrics);
      state.totalSessions++;
      
      ctx.log.info(`[analytics] New session tracked: ${event.session}`);
    });

    // Track injection start time for latency calculation
    ctx.events.on("session:beforeInject", (event) => {
      state.pendingInjects.set(event.session, Date.now());
    });

    // Track response chunks for real-time metrics
    ctx.events.on("session:responseChunk", (event) => {
      const metrics = state.sessions.get(event.session);
      if (metrics) {
        metrics.totalResponseLength += event.chunk.length;
        metrics.lastMessageAt = Date.now();
      }
    });

    // Finalize metrics after injection completes
    ctx.events.on("session:afterInject", (event) => {
      const metrics = state.sessions.get(event.session);
      if (metrics) {
        metrics.messageCount++;
        state.totalMessages++;
        
        // Calculate latency
        const startTime = state.pendingInjects.get(event.session);
        if (startTime) {
          const latency = Date.now() - startTime;
          state.pendingInjects.delete(event.session);
          
          ctx.log.info(`[analytics] Injection completed:`);
          ctx.log.info(`[analytics]   Session: ${event.session}`);
          ctx.log.info(`[analytics]   Latency: ${latency}ms`);
          ctx.log.info(`[analytics]   Messages in session: ${metrics.messageCount}`);
        }
      }
    });

    // Clean up when session is destroyed
    ctx.events.on("session:destroy", (event) => {
      const metrics = state.sessions.get(event.session);
      if (metrics) {
        const sessionDuration = Date.now() - metrics.firstMessageAt;
        
        ctx.log.info(`[analytics] Session ended: ${event.session}`);
        ctx.log.info(`[analytics]   Duration: ${Math.round(sessionDuration / 1000)}s`);
        ctx.log.info(`[analytics]   Total messages: ${metrics.messageCount}`);
        ctx.log.info(`[analytics]   Avg response length: ${Math.round(metrics.totalResponseLength / metrics.messageCount)} chars`);
        
        state.sessions.delete(event.session);
        state.pendingInjects.delete(event.session);
      }
    });

    // ============================================================================
    // Periodic Reporting (every 5 minutes)
    // ============================================================================

    const reportInterval = setInterval(() => {
      const activeSessions = state.sessions.size;
      const avgMessagesPerSession = activeSessions > 0 
        ? Math.round(state.totalMessages / state.totalSessions)
        : 0;

      ctx.log.info(`[analytics] === Periodic Report ===`);
      ctx.log.info(`[analytics] Active sessions: ${activeSessions}`);
      ctx.log.info(`[analytics] Total sessions: ${state.totalSessions}`);
      ctx.log.info(`[analytics] Total messages: ${state.totalMessages}`);
      ctx.log.info(`[analytics] Avg messages/session: ${avgMessagesPerSession}`);
    }, 5 * 60 * 1000);

    (ctx.config as any).reportInterval = reportInterval;

    // ============================================================================
    // Custom Event API
    // ============================================================================

    // Emit custom events for external systems to consume
    ctx.events.on("session:afterInject", async (event) => {
      const metrics = state.sessions.get(event.session);
      if (metrics && metrics.messageCount % 10 === 0) {
        // Emit milestone event every 10 messages
        await ctx.events.emitCustom("analytics:milestone", {
          session: event.session,
          milestone: metrics.messageCount,
          timestamp: Date.now(),
        });
      }
    });

    ctx.log.info("[analytics] Initialized successfully!");
  },

  async destroy(ctx: WOPRPluginContext) {
    ctx.log.info("[analytics] Destroying...");

    // Clear intervals
    const interval = (ctx.config as any).reportInterval;
    if (interval) {
      clearInterval(interval);
    }

    // Final report
    const state = (ctx.config as any).state as PluginState;
    if (state) {
      ctx.log.info(`[analytics] === Final Report ===`);
      ctx.log.info(`[analytics] Total sessions: ${state.totalSessions}`);
      ctx.log.info(`[analytics] Total messages: ${state.totalMessages}`);
    }

    ctx.log.info("[analytics] Destroyed successfully!");
  },

  // ============================================================================
  // CLI Commands for Analytics
  // ============================================================================

  commands: {
    async stats(ctx: WOPRPluginContext) {
      const state = (ctx.config as any).state as PluginState;
      if (!state) {
        return "Analytics not initialized";
      }

      const activeSessions = state.sessions.size;
      const activeList = Array.from(state.sessions.entries())
        .map(([name, metrics]) => {
          const duration = Math.round((Date.now() - metrics.firstMessageAt) / 1000);
          return `  - ${name}: ${metrics.messageCount} msgs, ${duration}s active`;
        })
        .join("\n");

      return [
        "=== Analytics Stats ===",
        `Active sessions: ${activeSessions}`,
        `Total sessions: ${state.totalSessions}`,
        `Total messages: ${state.totalMessages}`,
        activeSessions > 0 ? "\nActive Sessions:" : "",
        activeList,
      ].filter(Boolean).join("\n");
    },

    async reset(ctx: WOPRPluginContext) {
      const state = (ctx.config as any).state as PluginState;
      if (state) {
        state.sessions.clear();
        state.pendingInjects.clear();
        state.totalMessages = 0;
        state.totalSessions = 0;
      }
      return "Analytics reset";
    },
  },
};

export default plugin;
