/**
 * WOPR Daemon - HTTP API Server
 *
 * Hono-based server providing REST API for all WOPR functionality.
 * Supports WebSocket for real-time streaming.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { logger as winstonLogger } from "../logger.js";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";

import { PID_FILE, LOG_FILE } from "../paths.js";
import { config as centralConfig } from "../core/config.js";
import { sessionsRouter } from "./routes/sessions.js";
import { cronsRouter } from "./routes/crons.js";
import { authRouter } from "./routes/auth.js";
import { pluginsRouter } from "./routes/plugins.js";
import { skillsRouter } from "./routes/skills.js";
import { configRouter } from "./routes/config.js";
import { hooksRouter } from "./routes/hooks.js";
import { providersRouter } from "./routes/providers.js";
import { setupWebSocket, handleWebSocketMessage, handleWebSocketClose, broadcast } from "./ws.js";

// Core imports for daemon functionality
import { getCrons, saveCrons, shouldRunCron, addCronHistory } from "../core/cron.js";
import { inject } from "../core/sessions.js";
import { loadAllPlugins, shutdownAllPlugins } from "../plugins.js";
import type { StreamCallback } from "../types.js";

// Provider registry imports
import { providerRegistry } from "../core/providers.js";

const DEFAULT_PORT = parseInt(process.env.WOPR_DAEMON_PORT || "7437");
const DEFAULT_HOST = process.env.WOPR_DAEMON_HOST || "127.0.0.1";

export interface DaemonConfig {
  port?: number;
  host?: string;
}

export function createApp() {
  const app = new Hono();

  // Middleware
  app.use("*", cors());
  app.use("*", logger());

  // Health check
  app.get("/", (c) => c.json({
    name: "wopr",
    version: "0.0.1",
    status: "running",
  }));

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Mount routers
  app.route("/auth", authRouter);
  app.route("/config", configRouter);
  app.route("/sessions", sessionsRouter);
  app.route("/crons", cronsRouter);
  app.route("/plugins", pluginsRouter);
  app.route("/skills", skillsRouter);
  app.route("/hooks", hooksRouter);
  app.route("/providers", providersRouter);

  return app;
}

export function daemonLog(msg: string): void {
  const timestamp = new Date().toISOString();
  writeFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`, { flag: "a" });
}

export async function startDaemon(config: DaemonConfig = {}): Promise<void> {
  const port = config.port ?? DEFAULT_PORT;
  const host = config.host ?? DEFAULT_HOST;

  // Load config from disk first
  await centralConfig.load();
  daemonLog("Configuration loaded from disk");

  // Write PID file
  writeFileSync(PID_FILE, process.pid.toString());
  daemonLog(`Daemon started (PID ${process.pid})`);

  // Initialize provider registry (load credentials only, providers register via plugins)
  daemonLog("Initializing provider registry...");
  try {
    await providerRegistry.loadCredentials();
    daemonLog("Provider credentials loaded");
  } catch (err) {
    daemonLog(`Warning: Provider registry initialization failed: ${err}`);
  }

  // Create Hono app
  const app = createApp();

  // Setup WebSocket using @hono/node-ws
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // WebSocket endpoint
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupWebSocket(ws as unknown as { send(data: string): void });
      },
      onMessage(event, ws) {
        handleWebSocketMessage(ws as unknown as { send(data: string): void }, event.data.toString());
      },
      onClose(_event, ws) {
        handleWebSocketClose(ws as unknown as { send(data: string): void });
      },
    }))
  );

  // Create injectors for plugins
  const injectors = {
    inject: async (session: string, message: string, options?: import("../types.js").PluginInjectOptions): Promise<string> => {
      const result = await inject(session, message, { silent: true, ...options });
      return result.response;
    },
    getSessions: () => {
      const { getSessions } = require("../core/sessions.js");
      return Object.keys(getSessions());
    },
  };

  // Load plugins (this is where providers register themselves)
  await loadAllPlugins(injectors);

  // Check provider health after plugins have registered
  try {
    const providers = providerRegistry.listProviders();
    daemonLog(`Providers registered: ${providers.map(p => p.id).join(", ") || "none (install provider plugins)"}`);
    
    await providerRegistry.checkHealth();
    const available = providers.filter(p => p.available).map(p => p.id).join(", ");
    daemonLog(`Provider health check complete. Available: ${available || "none"}`);
  } catch (err) {
    daemonLog(`Warning: Provider health check failed: ${err}`);
  }

  // Start cron scheduler
  const lastRun: Record<string, number> = {};
  const cronTick = async () => {
    const now = new Date();
    const nowTs = now.getTime();
    let crons = getCrons();
    const toRemove: string[] = [];

    for (const cron of crons) {
      const key = cron.name;
      let shouldExecute = false;

      if (cron.runAt) {
        if (nowTs >= cron.runAt && !lastRun[key]) shouldExecute = true;
      } else {
        const lastMinute = lastRun[key] || 0;
        const currentMinute = Math.floor(nowTs / 60000);
        if (currentMinute > lastMinute && shouldRunCron(cron.schedule, now)) shouldExecute = true;
      }

      if (shouldExecute) {
        lastRun[key] = Math.floor(nowTs / 60000);
        daemonLog(`Running: ${cron.name} -> ${cron.session}`);
        const startTime = Date.now();
        try {
          await inject(cron.session, cron.message, { silent: true, from: "cron" });
          const durationMs = Date.now() - startTime;
          daemonLog(`Completed: ${cron.name} (${durationMs}ms)`);

          // Log success to history
          addCronHistory({
            name: cron.name,
            session: cron.session,
            timestamp: startTime,
            success: true,
            durationMs,
            message: cron.message,
          });

          if (cron.once) {
            toRemove.push(cron.name);
            daemonLog(`Auto-removed one-time job: ${cron.name}`);
          }
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const errorMsg = err instanceof Error ? err.message : String(err);
          daemonLog(`Error: ${cron.name} - ${errorMsg}`);

          // Log failure to history
          addCronHistory({
            name: cron.name,
            session: cron.session,
            timestamp: startTime,
            success: false,
            durationMs,
            error: errorMsg,
            message: cron.message,
          });
        }
      }
    }

    if (toRemove.length > 0) {
      crons = crons.filter(c => !toRemove.includes(c.name));
      saveCrons(crons);
    }
  };

  setInterval(cronTick, 30000);
  cronTick();

  // Shutdown handler
  const shutdown = async () => {
    daemonLog("Daemon stopping...");
    await shutdownAllPlugins();
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    daemonLog("Daemon stopped");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start server
  daemonLog(`Listening on http://${host}:${port}`);
  winstonLogger.info(`WOPR daemon listening on http://${host}:${port}`);

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  // Inject WebSocket upgrade handler
  injectWebSocket(server);
}

export function getDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    unlinkSync(PID_FILE);
    return null;
  }
}

export function getDaemonUrl(): string {
  return `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
}
