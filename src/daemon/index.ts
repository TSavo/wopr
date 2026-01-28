/**
 * WOPR Daemon - HTTP API Server
 *
 * Hono-based server providing REST API for all WOPR functionality.
 * Supports WebSocket for real-time streaming.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";

import { PID_FILE, LOG_FILE } from "../paths.js";
import { config as centralConfig } from "../core/config.js";
import { sessionsRouter } from "./routes/sessions.js";
import { cronsRouter } from "./routes/crons.js";
import { authRouter } from "./routes/auth.js";
import { peersRouter } from "./routes/peers.js";
import { pluginsRouter } from "./routes/plugins.js";
import { skillsRouter } from "./routes/skills.js";
import { identityRouter } from "./routes/identity.js";
import { discoverRouter } from "./routes/discover.js";
import { configRouter } from "./routes/config.js";
import { middlewareRouter } from "./routes/middleware.js";
import { providersRouter } from "./routes/providers.js";
import { setupWebSocket, handleWebSocketMessage, handleWebSocketClose, broadcast } from "./ws.js";

// Core imports for daemon functionality
import { getCrons, saveCrons, shouldRunCron } from "../core/cron.js";
import { inject } from "../core/sessions.js";
import { sendP2PChannelMessage, startP2PChannel } from "../channels/p2p-channel.js";
import {
  initDiscovery, joinTopic, updateProfile, shutdownDiscovery
} from "../discovery.js";
import { getIdentity } from "../identity.js";
import { loadAllPlugins, shutdownAllPlugins } from "../plugins.js";
import { getPeers } from "../trust.js";
import { shortKey } from "../identity.js";
import type { StreamCallback, Peer } from "../types.js";

// Provider registry imports
import { providerRegistry } from "../core/providers.js";

const DEFAULT_PORT = 7437;
const DEFAULT_HOST = "127.0.0.1";

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
  app.route("/peers", peersRouter);
  app.route("/plugins", pluginsRouter);
  app.route("/skills", skillsRouter);
  app.route("/identity", identityRouter);
  app.route("/discover", discoverRouter);
  app.route("/middleware", middlewareRouter);
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
  const identity = getIdentity();
  const injectors = {
    inject: async (session: string, message: string, options?: import("../types.js").PluginInjectOptions): Promise<string> => {
      const result = await inject(session, message, { silent: true, ...options });
      return result.response;
    },
    injectPeer: async (peer: string, session: string, message: string): Promise<string> => {
      const result = await sendP2PChannelMessage(peer, session, message);
      return result.message || "";
    },
    getIdentity: () => identity ? {
      publicKey: identity.publicKey,
      shortId: shortKey(identity.publicKey),
      encryptPub: identity.encryptPub,
    } : { publicKey: "", shortId: "", encryptPub: "" },
    getSessions: () => {
      const { getSessions } = require("../core/sessions.js");
      return Object.keys(getSessions());
    },
    getPeers: (): Peer[] => getPeers(),
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
        try {
          await inject(cron.session, cron.message, { silent: true, from: "cron" });
          daemonLog(`Completed: ${cron.name}`);
          if (cron.once) {
            toRemove.push(cron.name);
            daemonLog(`Auto-removed one-time job: ${cron.name}`);
          }
        } catch (err) {
          daemonLog(`Error: ${cron.name} - ${err}`);
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

  // Start P2P listener
  const swarm = startP2PChannel(
    async (session, message, peerKey, channel) => {
      await inject(session, message, { silent: true, from: peerKey || "p2p", channel });
    },
    daemonLog
  );

  // Discovery mode - join topics from env var WOPR_TOPICS
  const topicsEnv = process.env.WOPR_TOPICS;
  if (topicsEnv) {
    const topics = topicsEnv.split(",").map(t => t.trim()).filter(t => t);
    if (topics.length > 0) {
      daemonLog(`Discovery: joining ${topics.length} topic(s)`);

      const connectionHandler = async (peerProfile: any, topic: string) => {
        daemonLog(`Connection request from ${peerProfile.id} in ${topic}`);
        return {
          accept: true,
          sessions: ["*"],
          reason: `Discovered in ${topic}`,
        };
      };

      await initDiscovery(connectionHandler, daemonLog);

      if (identity) {
        updateProfile({
          type: "wopr-daemon",
          ready: true,
        });
      }

      for (const topic of topics) {
        await joinTopic(topic);
        daemonLog(`Joined topic: ${topic}`);
      }
    }
  }

  // Shutdown handler
  const shutdown = async () => {
    daemonLog("Daemon stopping...");
    await shutdownAllPlugins();
    await shutdownDiscovery();
    if (swarm) await swarm.destroy();
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    daemonLog("Daemon stopped");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Start server
  daemonLog(`Listening on http://${host}:${port}`);
  console.log(`WOPR daemon listening on http://${host}:${port}`);

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
