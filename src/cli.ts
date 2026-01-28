#!/usr/bin/env node

/**
 * WOPR CLI - Thin client for the WOPR daemon
 *
 * All functionality runs through the HTTP daemon. The CLI is just a thin wrapper
 * that makes HTTP calls and formats output.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

import { WOPR_HOME, SESSIONS_DIR, SKILLS_DIR, LOG_FILE, PID_FILE } from "./paths.js";
import { WoprClient } from "./client.js";
import { parseTimeSpec } from "./core/cron.js";
import { shortKey } from "./identity.js";
import { config } from "./core/config.js";
import { EXIT_OK, EXIT_INVALID } from "./types.js";
import {
  generatePKCE, buildAuthUrl, exchangeCode, saveOAuthTokens, saveApiKey,
  loadAuth, clearAuth, loadClaudeCodeCredentials
} from "./auth.js";
import { providerRegistry } from "./core/providers.js";

// Ensure directories exist
[WOPR_HOME, SESSIONS_DIR, SKILLS_DIR].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

const client = new WoprClient();

// Helper to check daemon is running
async function requireDaemon(): Promise<void> {
  if (!(await client.isRunning())) {
    console.error("Daemon not running. Start it: wopr daemon start");
    process.exit(1);
  }
}

// ==================== Daemon Management ====================

function getDaemonPid(): number | null {
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

// ==================== CLI Commands ====================

function help(): void {
  console.log(`
wopr - Self-sovereign AI session management

Usage:
  wopr init                              Interactive setup wizard

  wopr session create <name> [context]   Create a session with optional context
  wopr session create <name> --provider <id> [--fallback chain]  Create with provider
  wopr session inject <name> <message>   Inject a message into a session
  wopr session list                      List all sessions
  wopr session show <name> [--limit N]   Show session details and conversation history
  wopr session delete <name>             Delete a session
  wopr session set-provider <name> <id> [--fallback chain]  Update session provider

  wopr skill list                        List installed skills
  wopr skill install <url|slug> [name]   Install skill from URL or registry
  wopr skill create <name> [desc]        Create a new skill
  wopr skill remove <name>               Remove a skill
  wopr skill search <query>              Search registries for skills
  wopr skill cache clear                 Clear registry cache

  wopr skill registry list               List configured registries
  wopr skill registry add <name> <url>   Add a skill registry
  wopr skill registry remove <name>      Remove a registry

  wopr cron add <name> <sched> <sess> <msg>  Add scheduled injection [--now] [--once]
  wopr cron once <time> <session> <message>  One-time job (time: now, +5m, +1h, 09:00)
  wopr cron now <session> <message>          Run immediately (no scheduling)
  wopr cron remove <name>                    Remove a cron
  wopr cron list                             List crons

  wopr config get [key]                      Show config (all or specific key)
  wopr config set <key> <value>              Set config value (e.g., daemon.port)
  wopr config reset                          Reset to defaults
  wopr config list                           List all config values

  wopr daemon start                          Start scheduler daemon
  wopr daemon stop                           Stop daemon
  wopr daemon status                         Check if daemon is running
  wopr daemon logs                           Show daemon logs

  wopr auth                                  Show auth status
  wopr auth login                            Login with Claude Max/Pro (OAuth)
  wopr auth api-key <key>                    Use API key instead
  wopr auth logout                           Clear credentials

  wopr id                                    Show your WOPR ID
  wopr id init [--force]                     Generate identity keypair
  wopr id rotate [--broadcast]               Rotate keys (notifies peers if --broadcast)

  wopr invite <peer-pubkey> <session>        Create invite for specific peer
  wopr invite claim <token>                  Claim an invite (P2P handshake)

  wopr p2p friend add <peer-pubkey> [sess]   Create invite and optionally claim theirs

  wopr access                                Who can inject to your sessions
  wopr revoke <peer>                         Revoke someone's access

  wopr peers                                 Who you can inject to
  wopr peers name <id> <name>                Give a peer a friendly name

  wopr inject <peer>:<session> <message>     Send to peer (P2P encrypted)

  wopr discover join <topic>                 Join a topic to find peers
  wopr discover leave <topic>                Leave a topic
  wopr discover topics                       List topics you're in
  wopr discover peers [topic]                List discovered peers
  wopr discover connect <peer-id>            Request connection with peer
  wopr discover profile                      Show your current profile
  wopr discover profile set <json>           Set profile content (AI-driven)

  wopr plugin list                           List installed plugins
  wopr plugin install <source>               Install (npm pkg, github:u/r, or ./local)
  wopr plugin remove <name>                  Remove a plugin
  wopr plugin enable <name>                  Enable a plugin
  wopr plugin disable <name>                 Disable a plugin
  wopr plugin search <query>                 Search npm for plugins

  wopr plugin registry list                  List plugin registries
  wopr plugin registry add <name> <url>      Add a plugin registry
  wopr plugin registry remove <name>         Remove a plugin registry

  wopr providers list                        List all providers and status
  wopr providers add <id> [credential]       Add/update provider credential
  wopr providers remove <id>                 Remove provider credential
  wopr providers health-check                Check health of all providers

  wopr middleware list                       List all middleware
  wopr middleware chain                      Show execution order
  wopr middleware show <name>                Show middleware details
  wopr middleware enable <name>              Enable middleware
  wopr middleware disable <name>             Disable middleware
  wopr middleware priority <name> <n>        Set middleware priority

  wopr context list                          List all context providers
  wopr context show <name>                   Show context provider details
  wopr context enable <name>                 Enable context provider
  wopr context disable <name>                Disable context provider
  wopr context priority <name> <n>           Set context provider priority

Environment:
  WOPR_HOME                              Base directory (default: ~/wopr)
  ANTHROPIC_API_KEY                      API key for Claude (Anthropic)
  OPENAI_API_KEY                         API key for Codex (OpenAI)

Supported Providers:
  anthropic                              Claude models via Agent SDK
  codex                                  OpenAI Codex agent for coding tasks

P2P messages are end-to-end encrypted using X25519 ECDH + AES-256-GCM.
Tokens are bound to the recipient's public key - they cannot be forwarded.
Discovery is ephemeral - you see peers only while both are online in the same topic.
`);
}

// ==================== Main ====================

const [,, command, subcommand, ...args] = process.argv;

// Helper to parse flags
function parseFlags(args: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { flags, positional };
}

(async () => {
  if (command === "providers") {
    await requireDaemon();
    await providerRegistry.loadCredentials();

    switch (subcommand) {
      case "list": {
        const providers = await client.getProviders();
        if (providers.length === 0) {
          console.log("No providers registered.");
        } else {
          console.log("Registered providers:");
          console.log("ID              | Name              | Available");
          console.log("----------------|-------------------|----------");
          for (const p of providers) {
            const id = p.id.padEnd(15);
            const name = (p.name || "N/A").padEnd(19);
            const status = p.available ? "Yes" : "No";
            console.log(`${id}| ${name}| ${status}`);
          }
        }
        break;
      }

      case "add": {
        if (!args[0]) {
          console.error("Usage: wopr providers add <provider-id> [credential]");
          process.exit(1);
        }

        const providerId = args[0];
        let credential = args[1];

        // If no credential provided, prompt for it
        if (!credential) {
          const readline = await import("readline/promises");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          credential = await rl.question(`Enter credential for ${providerId}: `);
          rl.close();

          if (!credential) {
            console.error("Credential required");
            process.exit(1);
          }
        }

        try {
          await client.addProviderCredential(providerId, credential);
          console.log(`Credential added for provider: ${providerId}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`Failed to add credential: ${msg}`);
          process.exit(1);
        }
        break;
      }

      case "remove": {
        if (!args[0]) {
          console.error("Usage: wopr providers remove <provider-id>");
          process.exit(1);
        }

        const providerId = args[0];
        try {
          await providerRegistry.removeCredential(providerId);
          console.log(`Removed credential for provider: ${providerId}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`Failed to remove credential: ${msg}`);
          process.exit(1);
        }
        break;
      }

      case "health-check": {
        console.log("Checking provider health...");
        await client.checkProvidersHealth();

        const providers = await client.getProviders();
        const healthy = providers.filter((p: any) => p.available);
        const unhealthy = providers.filter((p: any) => !p.available);

        if (healthy.length > 0) {
          console.log("\nHealthy:");
          for (const p of healthy) {
            console.log(`  ${p.id}: OK`);
          }
        }

        if (unhealthy.length > 0) {
          console.log("\nUnhealthy:");
          for (const p of unhealthy) {
            console.log(`  ${p.id}: Not available`);
          }
        }

        if (providers.length === 0) {
          console.log("No providers registered.");
        }
        break;
      }

      default:
        help();
    }
  } else if (command === "session") {
    await requireDaemon();
    switch (subcommand) {
      case "create": {
        if (!args[0]) {
          console.error("Usage: wopr session create <name> [context] [--provider <id>] [--fallback chain]");
          process.exit(1);
        }

        const { flags, positional } = parseFlags(args.slice(1));
        const name = args[0];
        const context = positional.length > 0 ? positional.join(" ") : undefined;

        // Create session via daemon
        await client.createSession(name, context);

        // Store provider config if specified
        if (flags.provider) {
          const providerConfig = {
            name: flags.provider as string,
            fallback: flags.fallback ? (flags.fallback as string).split(",").map(s => s.trim()) : undefined,
          };
          const { SESSIONS_DIR } = await import("./paths.js");
          const providerFile = (await import("path")).join(SESSIONS_DIR, `${name}.provider.json`);
          (await import("fs/promises")).writeFile(providerFile, JSON.stringify(providerConfig, null, 2));

          console.log(
            `Created session "${name}" with provider: ${flags.provider}${
              flags.fallback ? ` (fallback: ${flags.fallback})` : ""
            }`
          );
        } else {
          console.log(`Created session "${name}"`);
        }
        break;
      }

      case "set-provider": {
        if (!args[0] || !args[1]) {
          console.error("Usage: wopr session set-provider <name> <provider-id> [--fallback chain]");
          process.exit(1);
        }

        const { flags } = parseFlags(args.slice(2));
        const sessionName = args[0];
        const providerId = args[1];

        // Verify session exists
        try {
          await client.getSession(sessionName);
        } catch (error) {
          console.error(`Session not found: ${sessionName}`);
          process.exit(1);
        }

        const providerConfig = {
          name: providerId,
          fallback: flags.fallback ? (flags.fallback as string).split(",").map(s => s.trim()) : undefined,
        };

        // Save provider config
        const { SESSIONS_DIR } = await import("./paths.js");
        const providerFile = (await import("path")).join(SESSIONS_DIR, `${sessionName}.provider.json`);
        await (await import("fs/promises")).writeFile(providerFile, JSON.stringify(providerConfig, null, 2));

        console.log(
          `Updated session "${sessionName}" provider to: ${providerId}${
            flags.fallback ? ` (fallback: ${flags.fallback})` : ""
          }`
        );
        break;
      }
      case "inject":
        if (!args[0] || !args[1]) {
          console.error("Usage: wopr session inject <name> <message>");
          process.exit(1);
        }
        console.log(`[wopr] Injecting into session: ${args[0]}`);
        await client.inject(args[0], args.slice(1).join(" "), (msg) => {
          if (msg.type === "text") {
            process.stdout.write(msg.content);
          } else if (msg.type === "tool_use") {
            console.log(`\n[tool] ${msg.toolName}`);
          } else if (msg.type === "complete") {
            console.log(`\n[wopr] ${msg.content}`);
          } else if (msg.type === "error") {
            console.error(`\n[wopr] Error: ${msg.content}`);
          }
        });
        break;
      case "list": {
        const sessions = await client.getSessions();
        if (sessions.length === 0) {
          console.log("No sessions.");
        } else {
          console.log("Sessions:");
          for (const s of sessions) {
            console.log(`  ${s.name}${s.hasContext ? " (has context)" : ""}`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          console.error("Usage: wopr session show <name> [--limit N]");
          process.exit(1);
        }
        const session = await client.getSession(args[0]);
        console.log(`Session: ${session.name}`);
        console.log(`ID: ${session.id || "(not started)"}`);
        if (session.context) console.log(`\n--- Context ---\n${session.context}\n--- End ---`);

        // Show conversation history
        const limitIndex = args.indexOf("--limit");
        const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1], 10) : 20;
        const history = await client.getConversationHistory(args[0], limit);

        if (history.entries.length > 0) {
          console.log(`\n--- Conversation History (last ${history.count} entries) ---`);
          for (const entry of history.entries) {
            const timestamp = new Date(entry.ts).toLocaleTimeString();
            const prefix = entry.type === "context" ? "[context]" :
                          entry.type === "response" ? "[WOPR]" :
                          `[${entry.from}]`;
            // Truncate long messages for readability
            const content = entry.content.length > 200 ?
              entry.content.substring(0, 200) + "..." :
              entry.content;
            console.log(`${timestamp} ${prefix}: ${content}`);
          }
          console.log(`--- End History ---`);
        } else {
          console.log("\nNo conversation history yet.");
        }
        break;
      }
      case "delete": {
        if (!args[0]) {
          console.error("Usage: wopr session delete <name>");
          process.exit(1);
        }
        await client.deleteSession(args[0]);
        console.log(`Deleted session "${args[0]}"`);
        break;
      }
      default:
        help();
    }
  } else if (command === "skill") {
    await requireDaemon();
    if (subcommand === "registry") {
      const registryCmd = args[0];
      switch (registryCmd) {
        case "list": {
          const registries = await client.getSkillRegistries();
          if (registries.length === 0) {
            console.log("No registries. Add: wopr skill registry add <name> <url>");
          } else {
            console.log("Registries:");
            for (const r of registries) console.log(`  ${r.name}: ${r.url}`);
          }
          break;
        }
        case "add":
          if (!args[1] || !args[2]) {
            console.error("Usage: wopr skill registry add <name> <url>");
            process.exit(1);
          }
          await client.addSkillRegistry(args[1], args[2]);
          console.log(`Added registry: ${args[1]}`);
          break;
        case "remove":
          if (!args[1]) {
            console.error("Usage: wopr skill registry remove <name>");
            process.exit(1);
          }
          await client.removeSkillRegistry(args[1]);
          console.log(`Removed registry: ${args[1]}`);
          break;
        default:
          help();
      }
    } else {
      switch (subcommand) {
        case "list": {
          const skills = await client.getSkills();
          if (skills.length === 0) {
            console.log(`No skills. Add to ${SKILLS_DIR}/<name>/SKILL.md`);
          } else {
            console.log("Skills:");
            for (const s of skills) console.log(`  ${s.name} - ${s.description}`);
          }
          break;
        }
        case "search": {
          if (!args[0]) {
            console.error("Usage: wopr skill search <query>");
            process.exit(1);
          }
          const results = await client.searchSkills(args.join(" "));
          if (results.length === 0) {
            console.log(`No skills found matching "${args.join(" ")}"`);
          } else {
            console.log(`Found ${results.length} skill(s):`);
            for (const skill of results) {
              console.log(`  ${skill.name} (${skill.registry})`);
              console.log(`    ${skill.description}`);
              console.log(`    wopr skill install ${skill.source}`);
            }
          }
          break;
        }
        case "install": {
          if (!args[0]) {
            console.error("Usage: wopr skill install <source> [name]");
            process.exit(1);
          }
          console.log(`Installing...`);
          await client.installSkill(args[0], args[1]);
          console.log(`Installed: ${args[1] || args[0]}`);
          break;
        }
        case "create": {
          if (!args[0]) {
            console.error("Usage: wopr skill create <name> [description]");
            process.exit(1);
          }
          await client.createSkill(args[0], args.slice(1).join(" ") || undefined);
          console.log(`Created: ${join(SKILLS_DIR, args[0], "SKILL.md")}`);
          break;
        }
        case "remove": {
          if (!args[0]) {
            console.error("Usage: wopr skill remove <name>");
            process.exit(1);
          }
          await client.removeSkill(args[0]);
          console.log(`Removed: ${args[0]}`);
          break;
        }
        case "cache":
          if (args[0] === "clear") {
            await client.clearSkillCache();
            console.log("Cache cleared");
          }
          break;
        default:
          help();
      }
    }
  } else if (command === "cron") {
    await requireDaemon();
    switch (subcommand) {
      case "add": {
        const flags = { now: false, once: false };
        const filtered = args.filter(a => {
          if (a === "--now") { flags.now = true; return false; }
          if (a === "--once") { flags.once = true; return false; }
          return true;
        });
        if (filtered.length < 4) {
          console.error("Usage: wopr cron add <name> <schedule> <session> <message>");
          process.exit(1);
        }
        await client.addCron({
          name: filtered[0],
          schedule: filtered[1],
          session: filtered[2],
          message: filtered.slice(3).join(" "),
          once: flags.once || undefined,
        });
        console.log(`Added cron: ${filtered[0]}`);
        if (flags.now) {
          await client.inject(filtered[2], filtered.slice(3).join(" "), (msg) => {
            if (msg.type === "text") process.stdout.write(msg.content);
          });
        }
        break;
      }
      case "once": {
        if (args.length < 3) {
          console.error("Usage: wopr cron once <time> <session> <message>");
          process.exit(1);
        }
        const runAt = parseTimeSpec(args[0]);
        await client.addCron({
          name: `once-${Date.now()}`,
          schedule: "once",
          session: args[1],
          message: args.slice(2).join(" "),
          once: true,
          runAt,
        });
        console.log(`Scheduled for ${new Date(runAt).toLocaleString()}`);
        break;
      }
      case "now":
        if (args.length < 2) {
          console.error("Usage: wopr cron now <session> <message>");
          process.exit(1);
        }
        await client.inject(args[0], args.slice(1).join(" "), (msg) => {
          if (msg.type === "text") process.stdout.write(msg.content);
          else if (msg.type === "complete") console.log(`\n[wopr] ${msg.content}`);
        });
        break;
      case "remove": {
        if (!args[0]) {
          console.error("Usage: wopr cron remove <name>");
          process.exit(1);
        }
        await client.removeCron(args[0]);
        console.log(`Removed: ${args[0]}`);
        break;
      }
      case "list": {
        const crons = await client.getCrons();
        if (crons.length === 0) {
          console.log("No crons.");
        } else {
          console.log("Crons:");
          for (const c of crons) {
            if (c.runAt) {
              console.log(`  ${c.name}: once @ ${new Date(c.runAt).toLocaleString()}`);
            } else {
              console.log(`  ${c.name}: ${c.schedule}${c.once ? " (one-time)" : ""}`);
            }
            console.log(`    -> ${c.session}: "${c.message}"`);
          }
        }
        break;
      }
      default:
        help();
    }
  } else if (command === "config") {
    // Config doesn't require daemon - it's local file management
    await config.load();

    switch (subcommand) {
      case "get":
      case "list": {
        if (args[0]) {
          // Get specific key
          const value = config.getValue(args[0]);
          if (value === undefined) {
            console.error(`Config key "${args[0]}" not found`);
            process.exit(1);
          }
          console.log(JSON.stringify(value, null, 2));
        } else {
          // Show all config
          console.log(JSON.stringify(config.get(), null, 2));
        }
        break;
      }
      case "set": {
        if (!args[0] || args[1] === undefined) {
          console.error("Usage: wopr config set <key> <value>");
          process.exit(1);
        }
        const key = args[0];
        let value: any = args.slice(1).join(" ");

        // Try to parse as JSON for objects/arrays/numbers/booleans
        try {
          value = JSON.parse(value);
        } catch {
          // Keep as string if not valid JSON
        }

        config.setValue(key, value);
        await config.save();
        console.log(`Set ${key} = ${JSON.stringify(value)}`);
        break;
      }
      case "reset": {
        config.reset();
        await config.save();
        console.log("Config reset to defaults");
        break;
      }
      default:
        help();
    }
  } else if (command === "daemon") {
    switch (subcommand) {
      case "start": {
        const existing = getDaemonPid();
        if (existing) {
          console.log(`Daemon already running (PID ${existing})`);
          return;
        }
        const script = process.argv[1];
        const child = execSync(`nohup npx tsx "${script}" daemon run > /dev/null 2>&1 & echo $!`, {
          encoding: "utf-8",
          shell: "/bin/bash",
        });
        console.log(`Daemon started (PID ${child.trim()})`);
        break;
      }
      case "stop": {
        const pid = getDaemonPid();
        if (!pid) {
          console.log("Daemon not running");
          return;
        }
        process.kill(pid, "SIGTERM");
        console.log(`Daemon stopped (PID ${pid})`);
        break;
      }
      case "status": {
        const pid = getDaemonPid();
        console.log(pid ? `Daemon running (PID ${pid})` : "Daemon not running");
        break;
      }
      case "run":
        // Run the daemon directly (used by daemon start)
        const { startDaemon } = await import("./daemon/index.js");
        await startDaemon();
        break;
      case "logs":
        if (existsSync(LOG_FILE)) {
          console.log(readFileSync(LOG_FILE, "utf-8"));
        } else {
          console.log("No logs");
        }
        break;
      default:
        help();
    }
  } else if (command === "auth") {
    if (!subcommand || subcommand === "status") {
      const claudeCodeAuth = loadClaudeCodeCredentials();
      const auth = loadAuth();

      if (claudeCodeAuth) {
        console.log("Auth: Claude Code OAuth (shared credentials)");
        console.log("Source: ~/.claude/.credentials.json");
        if (claudeCodeAuth.expiresAt) {
          const exp = new Date(claudeCodeAuth.expiresAt);
          const now = Date.now();
          if (claudeCodeAuth.expiresAt > now) {
            console.log(`Expires: ${exp.toLocaleString()}`);
          } else {
            console.log(`Expired: ${exp.toLocaleString()} (will auto-refresh)`);
          }
        }
      } else if (!auth || (!auth.apiKey && !auth.accessToken)) {
        console.log("Not authenticated");
        console.log("\nLogin with Claude Max/Pro:");
        console.log("  wopr auth login");
        console.log("\nOr use an API key:");
        console.log("  wopr auth api-key <your-key>");
      } else if (auth.type === "oauth") {
        console.log("Auth: OAuth (Claude Max/Pro)");
        if (auth.email) console.log(`Email: ${auth.email}`);
        if (auth.expiresAt) {
          console.log(`Expires: ${new Date(auth.expiresAt).toLocaleString()}`);
        }
      } else if (auth.type === "api_key") {
        console.log("Auth: API Key");
        console.log(`Key: ${auth.apiKey?.substring(0, 12)}...`);
      }
    } else if (subcommand === "login") {
      const pkce = generatePKCE();
      const redirectUri = "http://localhost:9876/callback";
      const authUrl = buildAuthUrl(pkce, redirectUri);

      console.log("Opening browser for authentication...\n");
      console.log("If browser doesn't open, visit:");
      console.log(authUrl);
      console.log("\nWaiting for authentication...");

      const http = await import("http");
      const url = await import("url");

      const server = http.createServer(async (req, res) => {
        const parsed = url.parse(req.url || "", true);
        if (parsed.pathname === "/callback") {
          const code = parsed.query.code as string;
          const state = parsed.query.state as string;

          if (state !== pkce.state) {
            res.writeHead(400);
            res.end("Invalid state parameter");
            server.close();
            console.error("Error: Invalid state parameter");
            process.exit(1);
          }

          try {
            const tokens = await exchangeCode(code, pkce.codeVerifier, redirectUri);
            saveOAuthTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresIn);

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Success!</h1><p>You can close this window.</p></body></html>");
            server.close();

            console.log("\nAuthenticated successfully!");
            console.log("Your Claude Max/Pro subscription is now linked.");
            process.exit(0);
          } catch (err: any) {
            res.writeHead(500);
            res.end(`Error: ${err.message}`);
            server.close();
            console.error("Error:", err.message);
            process.exit(1);
          }
        }
      });

      server.listen(9876, () => {
        const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execSync(`${open} "${authUrl}"`, { stdio: "ignore" });
      });

      setTimeout(() => {
        console.error("\nTimeout waiting for authentication");
        server.close();
        process.exit(1);
      }, 5 * 60 * 1000);
    } else if (subcommand === "api-key") {
      if (!args[0]) {
        console.error("Usage: wopr auth api-key <your-api-key>");
        process.exit(1);
      }
      saveApiKey(args[0]);
      console.log("API key saved");
    } else if (subcommand === "logout") {
      clearAuth();
      console.log("Logged out");
    } else {
      help();
    }
  } else if (command === "id") {
    await requireDaemon();
    if (subcommand === "init") {
      const identity = await client.initIdentity(args.includes("--force"));
      console.log(`Identity created: ${shortKey(identity.publicKey)}`);
      console.log(`Full: wopr://${identity.publicKey}`);
    } else if (subcommand === "rotate") {
      const broadcast = args.includes("--broadcast");
      const result = await client.rotateIdentity(broadcast);
      console.log(`Keys rotated!`);
      console.log(`New ID: ${shortKey(result.newIdentity.publicKey)}`);
      console.log(`Old ID: ${shortKey(result.oldPublicKey)} (valid for 7 days)`);
      if (broadcast && result.notified) {
        console.log(`\nNotified ${result.notified.length} peer(s)`);
      } else if (!broadcast) {
        console.log("\nRun with --broadcast to notify peers of key change.");
      }
    } else if (!subcommand) {
      const identity = await client.getIdentity();
      if (!identity) {
        console.log("No identity. Run: wopr id init");
      } else {
        console.log(`WOPR ID: ${shortKey(identity.publicKey)}`);
        console.log(`Full: wopr://${identity.publicKey}`);
        console.log(`Encrypt: ${shortKey(identity.encryptPub)}`);
        if (identity.rotatedFrom) {
          console.log(`Rotated from: ${shortKey(identity.rotatedFrom)}`);
          console.log(`Rotated at: ${new Date(identity.rotatedAt).toLocaleString()}`);
        }
      }
    } else {
      help();
    }
  } else if (command === "p2p") {
    await requireDaemon();
    if (subcommand === "friend" && args[0] === "add") {
      const peerPubkey = args[1];
      if (!peerPubkey) {
        console.error("Usage: wopr p2p friend add <peer-pubkey> [session...] [--token <token>]");
        process.exit(1);
      }

      let token: string | undefined;
      const sessions: string[] = [];
      for (let i = 2; i < args.length; i += 1) {
        if (args[i] === "--token") {
          token = args[i + 1];
          i += 1;
          continue;
        }
        sessions.push(args[i]);
      }

      const grantSessions = sessions.length > 0 ? sessions : ["*"];
      const invite = await client.createInvite(peerPubkey, grantSessions);

      console.log(`Invite created for ${shortKey(peerPubkey)}`);
      console.log(invite.token);
      console.log(`Sessions: ${grantSessions.join(", ")}`);

      if (token) {
        console.log("\nClaiming their invite (peer must be online)...");
        const result = await client.claimInvite(token);
        if (result.code === EXIT_OK) {
          console.log(`Success! Added peer: ${shortKey(result.peerKey!)}`);
          console.log(`Sessions: ${result.sessions?.join(", ")}`);
        } else {
          console.error(`Failed to claim: ${result.message}`);
          process.exit(result.code);
        }
      } else {
        console.log("\nTo complete the handshake, rerun with their token:");
        console.log("  wopr p2p friend add <peer-pubkey> --token <their-token>");
      }
    } else {
      help();
    }
  } else if (command === "invite") {
    await requireDaemon();
    if (subcommand === "claim") {
      if (!args[0]) {
        console.error("Usage: wopr invite claim <token>");
        process.exit(1);
      }
      console.log("Claiming token (peer must be online)...");
      const result = await client.claimInvite(args[0]);
      if (result.code === EXIT_OK) {
        console.log(`Success! Added peer: ${shortKey(result.peerKey!)}`);
        console.log(`Sessions: ${result.sessions?.join(", ")}`);
      } else {
        console.error(`Failed: ${result.message}`);
        process.exit(result.code);
      }
    } else if (subcommand) {
      const peerPubkey = subcommand;
      const sessions = args.length > 0 ? args : ["*"];
      const result = await client.createInvite(peerPubkey, sessions);
      console.log(result.token);
      console.log(`\nFor peer: ${shortKey(peerPubkey)}`);
      console.log(`Sessions: ${sessions.join(", ")}`);
      console.log(`\nThey claim with: wopr invite claim <token>`);
    } else {
      console.error("Usage: wopr invite <peer-pubkey> <session>");
      console.error("       wopr invite claim <token>");
      process.exit(1);
    }
  } else if (command === "access") {
    await requireDaemon();
    const grants = await client.getAccessGrants();
    const active = grants.filter((g: any) => !g.revoked);
    if (active.length === 0) {
      console.log("No one has access. Create invite: wopr invite <peer-pubkey> <session>");
    } else {
      console.log("Access grants:");
      for (const g of active) {
        console.log(`  ${g.peerName || shortKey(g.peerKey)}`);
        console.log(`    Sessions: ${g.sessions.join(", ")}`);
      }
    }
  } else if (command === "revoke") {
    await requireDaemon();
    if (!subcommand) {
      console.error("Usage: wopr revoke <peer>");
      process.exit(1);
    }
    await client.revokePeer(subcommand);
    console.log(`Revoked: ${subcommand}`);
  } else if (command === "peers") {
    await requireDaemon();
    if (subcommand === "name") {
      if (!args[0] || !args[1]) {
        console.error("Usage: wopr peers name <id> <name>");
        process.exit(1);
      }
      await client.namePeer(args[0], args.slice(1).join(" "));
      console.log(`Named peer ${args[0]} as "${args.slice(1).join(" ")}"`);
    } else if (!subcommand) {
      const peers = await client.getPeers();
      if (peers.length === 0) {
        console.log("No peers. Claim an invite: wopr invite claim <token>");
      } else {
        console.log("Peers:");
        for (const p of peers) {
          console.log(`  ${p.name || p.id}${p.encryptPub ? " (encrypted)" : ""}`);
          console.log(`    Sessions: ${p.sessions.join(", ")}`);
        }
      }
    } else {
      help();
    }
  } else if (command === "inject") {
    await requireDaemon();
    if (!subcommand || !args.length) {
      console.error("Usage: wopr inject <peer>:<session> <message>");
      process.exit(EXIT_INVALID);
    }

    if (!subcommand.includes(":")) {
      console.error("Invalid target. Use: wopr inject <peer>:<session> <message>");
      process.exit(EXIT_INVALID);
    }

    const [peer, session] = subcommand.split(":");
    const message = args.join(" ");
    const result = await client.injectPeer(peer, session, message);

    if (result.code === EXIT_OK) {
      console.log("Delivered.");
    } else {
      console.error(result.message);
    }
    process.exit(result.code);
  } else if (command === "plugin") {
    // Show help if no subcommand, without requiring daemon
    if (!subcommand) {
      help();
      return;
    }
    await requireDaemon();
    if (subcommand === "registry") {
      const regCmd = args[0];
      switch (regCmd) {
        case "list": {
          const registries = await client.getPluginRegistries();
          if (registries.length === 0) {
            console.log("No plugin registries.");
          } else {
            console.log("Plugin registries:");
            for (const r of registries) console.log(`  ${r.name}: ${r.url}`);
          }
          break;
        }
        case "add":
          if (!args[1] || !args[2]) {
            console.error("Usage: wopr plugin registry add <name> <url>");
            process.exit(1);
          }
          await client.addPluginRegistry(args[1], args[2]);
          console.log(`Added registry: ${args[1]}`);
          break;
        case "remove":
          if (!args[1]) {
            console.error("Usage: wopr plugin registry remove <name>");
            process.exit(1);
          }
          await client.removePluginRegistry(args[1]);
          console.log(`Removed registry: ${args[1]}`);
          break;
        default:
          help();
      }
    } else {
      switch (subcommand) {
        case "list": {
          const plugins = await client.getPlugins();
          if (plugins.length === 0) {
            console.log("No plugins installed. Install: wopr plugin install <source>");
          } else {
            console.log("Installed plugins:");
            for (const p of plugins) {
              const status = p.enabled ? "enabled" : "disabled";
              console.log(`  ${p.name} v${p.version} (${p.source}, ${status})`);
              if (p.description) console.log(`    ${p.description}`);
            }
          }
          break;
        }
        case "install": {
          if (!args[0]) {
            console.error("Usage: wopr plugin install <source>");
            console.error("  npm:      wopr plugin install wopr-plugin-discord");
            console.error("  npm:      wopr plugin install wopr-p2p");
            console.error("  github:   wopr plugin install github:user/wopr-discord");
            console.error("  local:    wopr plugin install ./my-plugin");
            process.exit(1);
          }
          await client.installPlugin(args[0]);
          console.log(`Installed`);
          break;
        }
        case "remove": {
          if (!args[0]) {
            console.error("Usage: wopr plugin remove <name>");
            process.exit(1);
          }
          await client.removePlugin(args[0]);
          console.log(`Removed: ${args[0]}`);
          break;
        }
        case "enable": {
          if (!args[0]) {
            console.error("Usage: wopr plugin enable <name>");
            process.exit(1);
          }
          await client.enablePlugin(args[0]);
          console.log(`Enabled: ${args[0]}`);
          break;
        }
        case "disable": {
          if (!args[0]) {
            console.error("Usage: wopr plugin disable <name>");
            process.exit(1);
          }
          await client.disablePlugin(args[0]);
          console.log(`Disabled: ${args[0]}`);
          break;
        }
        case "search": {
          if (!args[0]) {
            console.error("Usage: wopr plugin search <query>");
            process.exit(1);
          }
          console.log(`Searching npm for wopr-plugin-${args[0]}...`);
          const results = await client.searchPlugins(args[0]);
          if (results.length === 0) {
            console.log("No plugins found.");
          } else {
            console.log("Found plugins:");
            for (const r of results) {
              console.log(`  ${r.name} - ${r.description || ""}`);
              console.log(`    wopr plugin install ${r.name}`);
            }
          }
          break;
        }
        default:
          help();
      }
    }
  } else if (command === "discover") {
    await requireDaemon();
    switch (subcommand) {
      case "join": {
        if (!args[0]) {
          console.error("Usage: wopr discover join <topic>");
          process.exit(1);
        }
        await client.joinTopic(args[0]);
        console.log(`Joined topic: ${args[0]}`);
        console.log("Use 'wopr discover peers' to see discovered peers.");
        break;
      }
      case "leave": {
        if (!args[0]) {
          console.error("Usage: wopr discover leave <topic>");
          process.exit(1);
        }
        await client.leaveTopic(args[0]);
        console.log(`Left topic: ${args[0]}`);
        break;
      }
      case "topics": {
        const topics = await client.getTopics();
        if (topics.length === 0) {
          console.log("Not in any topics. Join one: wopr discover join <topic>");
        } else {
          console.log("Active topics:");
          for (const t of topics) {
            const peers = await client.getDiscoveredPeers(t);
            console.log(`  ${t} (${peers.length} peers)`);
          }
        }
        break;
      }
      case "peers": {
        const topic = args[0];
        const peers = await client.getDiscoveredPeers(topic);
        if (peers.length === 0) {
          console.log("No peers discovered yet.");
        } else {
          console.log(`Discovered peers${topic ? ` in ${topic}` : ""}:`);
          for (const p of peers) {
            console.log(`  ${p.id} (${shortKey(p.publicKey)})`);
            if (p.content) {
              console.log(`    ${JSON.stringify(p.content)}`);
            }
            if (p.topics?.length > 0) {
              console.log(`    Topics: ${p.topics.join(", ")}`);
            }
          }
        }
        break;
      }
      case "connect": {
        if (!args[0]) {
          console.error("Usage: wopr discover connect <peer-id>");
          process.exit(1);
        }
        console.log(`Requesting connection with ${args[0]}...`);
        const result = await client.requestConnection(args[0]);
        if (result.code === EXIT_OK) {
          console.log("Connected!");
          if (result.sessions && result.sessions.length > 0) {
            console.log(`Sessions: ${result.sessions.join(", ")}`);
          }
        } else {
          console.error(`Failed: ${result.message}`);
        }
        process.exit(result.code);
      }
      case "profile": {
        if (args[0] === "set") {
          if (!args[1]) {
            console.error("Usage: wopr discover profile set <json>");
            console.error("Example: wopr discover profile set '{\"name\":\"Alice\",\"about\":\"Coding assistant\"}'");
            process.exit(1);
          }
          try {
            const content = JSON.parse(args.slice(1).join(" "));
            const profile = await client.setProfile(content);
            console.log("Profile updated:");
            console.log(`  ID: ${profile.id}`);
            console.log(`  Content: ${JSON.stringify(profile.content)}`);
          } catch (err: any) {
            console.error(`Invalid JSON: ${err.message}`);
            process.exit(1);
          }
        } else {
          const profile = await client.getProfile();
          if (!profile) {
            console.log("No profile set. Create one: wopr discover profile set <json>");
          } else {
            console.log("Current profile:");
            console.log(`  ID: ${profile.id}`);
            console.log(`  Content: ${JSON.stringify(profile.content, null, 2)}`);
            console.log(`  Topics: ${profile.topics?.join(", ") || "(none)"}`);
            console.log(`  Updated: ${new Date(profile.updated).toLocaleString()}`);
          }
        }
        break;
      }
      default:
        help();
    }
  } else if (command === "init") {
    // Interactive onboarding wizard
    const readline = await import("readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log("=== WOPR Configuration Wizard ===\n");

    // Load existing config
    await config.load();
    const existing = config.get();

    // Daemon settings
    console.log("Daemon Settings:");
    const port = await rl.question(`  Port [${existing.daemon.port}]: `);
    if (port) config.setValue("daemon.port", parseInt(port) || existing.daemon.port);

    const host = await rl.question(`  Host [${existing.daemon.host}]: `);
    if (host) config.setValue("daemon.host", host);

    const autoStart = await rl.question(`  Auto-start daemon? (y/n) [${existing.daemon.autoStart ? "y" : "n"}]: `);
    if (autoStart) config.setValue("daemon.autoStart", autoStart.toLowerCase() === "y");

    // Anthropic API Key
    console.log("\nAnthropic:");
    const hasKey = existing.anthropic.apiKey ? "(configured)" : "(not set)";
    const apiKey = await rl.question(`  API Key ${hasKey}: `);
    if (apiKey) config.setValue("anthropic.apiKey", apiKey);

    // OAuth
    console.log("\nOAuth (for claude.ai login):");
    const hasOAuth = existing.oauth.clientId ? "(configured)" : "(not set)";
    const clientId = await rl.question(`  Client ID ${hasOAuth}: `);
    if (clientId) {
      config.setValue("oauth.clientId", clientId);
      const clientSecret = await rl.question("  Client Secret: ");
      if (clientSecret) config.setValue("oauth.clientSecret", clientSecret);
      const redirectUri = await rl.question(`  Redirect URI [${existing.oauth.redirectUri || "http://localhost:3333/callback"}]: `);
      config.setValue("oauth.redirectUri", redirectUri || "http://localhost:3333/callback");
    }

    // Discord
    console.log("\nDiscord Bot (optional):");
    const hasDiscord = existing.discord?.token ? "(configured)" : "(not set)";
    const discordToken = await rl.question(`  Bot Token ${hasDiscord}: `);
    if (discordToken) {
      config.setValue("discord.token", discordToken);
      const guildId = await rl.question("  Guild ID (optional): ");
      if (guildId) config.setValue("discord.guildId", guildId);
    }

    // Discovery
    console.log("\nDiscovery:");
    const topics = await rl.question(`  Auto-join topics (comma-separated) [${existing.discovery.topics.join(",")}]: `);
    if (topics) config.setValue("discovery.topics", topics.split(",").map(t => t.trim()));

    const autoJoin = await rl.question(`  Auto-join on startup? (y/n) [${existing.discovery.autoJoin ? "y" : "n"}]: `);
    if (autoJoin) config.setValue("discovery.autoJoin", autoJoin.toLowerCase() === "y");

    // Save
    await config.save();
    rl.close();

    console.log("\n✓ Configuration saved!");
    console.log(`  Config file: ~/wopr/config.json`);
    console.log("\nNext steps:");
    console.log("  wopr daemon start    # Start the daemon");
    console.log("  wopr session create  # Create a session");
  } else if (command === "middleware") {
    await requireDaemon();
    switch (subcommand) {
      case "list": {
        const middlewares = await client.getMiddlewares();
        if (middlewares.length === 0) {
          console.log("No middleware registered.");
        } else {
          console.log("Middlewares:");
          console.log("Name              | Priority | Enabled | Hooks");
          console.log("------------------|----------|---------|-------");
          for (const m of middlewares) {
            const name = m.name.padEnd(17);
            const priority = m.priority.toString().padEnd(8);
            const enabled = (m.enabled ? "yes" : "no").padEnd(7);
            const hooks = [];
            if (m.hasIncoming) hooks.push("in");
            if (m.hasOutgoing) hooks.push("out");
            console.log(`${name}| ${priority}| ${enabled}| ${hooks.join(",") || "-"}`);
          }
        }
        break;
      }
      case "chain": {
        const chain = await client.getMiddlewareChain();
        if (chain.length === 0) {
          console.log("No middleware in chain.");
        } else {
          console.log("Middleware chain (execution order):");
          for (let i = 0; i < chain.length; i++) {
            const m = chain[i];
            const status = m.enabled ? "✓" : "✗";
            console.log(`  ${i + 1}. [${status}] ${m.name} (priority: ${m.priority})`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          console.error("Usage: wopr middleware show <name>");
          process.exit(1);
        }
        try {
          const m = await client.getMiddleware(args[0]);
          console.log(`Middleware: ${m.name}`);
          console.log(`  Priority: ${m.priority}`);
          console.log(`  Enabled: ${m.enabled ? "yes" : "no"}`);
          console.log(`  Incoming hook: ${m.hasIncoming ? "yes" : "no"}`);
          console.log(`  Outgoing hook: ${m.hasOutgoing ? "yes" : "no"}`);
        } catch (err: any) {
          console.error(`Middleware not found: ${args[0]}`);
          process.exit(1);
        }
        break;
      }
      case "enable": {
        if (!args[0]) {
          console.error("Usage: wopr middleware enable <name>");
          process.exit(1);
        }
        await client.enableMiddleware(args[0]);
        console.log(`Enabled middleware: ${args[0]}`);
        break;
      }
      case "disable": {
        if (!args[0]) {
          console.error("Usage: wopr middleware disable <name>");
          process.exit(1);
        }
        await client.disableMiddleware(args[0]);
        console.log(`Disabled middleware: ${args[0]}`);
        break;
      }
      case "priority": {
        if (!args[0] || args[1] === undefined) {
          console.error("Usage: wopr middleware priority <name> <priority>");
          console.error("  Lower priority runs first (default: 100)");
          process.exit(1);
        }
        const priority = parseInt(args[1], 10);
        if (isNaN(priority)) {
          console.error("Priority must be a number");
          process.exit(1);
        }
        await client.setMiddlewarePriority(args[0], priority);
        console.log(`Set ${args[0]} priority to ${priority}`);
        break;
      }
      default:
        help();
    }
  } else if (command === "context") {
    await requireDaemon();
    switch (subcommand) {
      case "list": {
        const providers = await client.getContextProviders();
        if (providers.length === 0) {
          console.log("No context providers registered.");
        } else {
          console.log("Context providers:");
          console.log("Name              | Priority | Enabled");
          console.log("------------------|----------|--------");
          for (const p of providers) {
            const name = p.name.padEnd(17);
            const priority = p.priority.toString().padEnd(8);
            const enabled = p.enabled ? "yes" : "no";
            console.log(`${name}| ${priority}| ${enabled}`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          console.error("Usage: wopr context show <name>");
          process.exit(1);
        }
        try {
          const p = await client.getContextProvider(args[0]);
          console.log(`Context provider: ${p.name}`);
          console.log(`  Priority: ${p.priority}`);
          console.log(`  Enabled: ${p.enabled ? "yes" : "no"}`);
        } catch (err: any) {
          console.error(`Context provider not found: ${args[0]}`);
          process.exit(1);
        }
        break;
      }
      case "enable": {
        if (!args[0]) {
          console.error("Usage: wopr context enable <name>");
          process.exit(1);
        }
        await client.enableContextProvider(args[0]);
        console.log(`Enabled context provider: ${args[0]}`);
        break;
      }
      case "disable": {
        if (!args[0]) {
          console.error("Usage: wopr context disable <name>");
          process.exit(1);
        }
        await client.disableContextProvider(args[0]);
        console.log(`Disabled context provider: ${args[0]}`);
        break;
      }
      case "priority": {
        if (!args[0] || args[1] === undefined) {
          console.error("Usage: wopr context priority <name> <priority>");
          console.error("  Lower priority runs first (appears earlier in context)");
          process.exit(1);
        }
        const priority = parseInt(args[1], 10);
        if (isNaN(priority)) {
          console.error("Priority must be a number");
          process.exit(1);
        }
        await client.setContextProviderPriority(args[0], priority);
        console.log(`Set ${args[0]} priority to ${priority}`);
        break;
      }
      default:
        help();
    }
  } else {
    help();
  }
})();
