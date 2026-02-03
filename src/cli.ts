#!/usr/bin/env node
import { logger } from "./logger.js";

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
    logger.error("Daemon not running. Start it: wopr daemon start");
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
  logger.info(`
wopr - Self-sovereign AI session management

Usage:
  wopr onboard                           Interactive onboarding wizard
  wopr configure                         Re-run configuration wizard

  wopr session create <name> [context]   Create a session with optional context
  wopr session create <name> --provider <id> [--fallback chain]  Create with provider
  wopr session inject <name> <message>   Inject a message into a session (gets AI response)
  wopr session log <name> <message>      Log a message to session history (no AI response)
  wopr session list                      List all sessions
  wopr session show <name> [--limit N]   Show session details and conversation history
  wopr session delete <name>             Delete a session
  wopr session set-provider <name> <id> [--model name] [--fallback chain]  Update session provider
  wopr session init-docs <name>          Initialize SOUL.md, AGENTS.md, USER.md for session

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
  wopr providers default <id> [options]      Set global provider defaults
    --model <name>                           Default model for this provider
    --reasoning-effort <level>               For Codex: minimal/low/medium/high/xhigh
  wopr providers show-defaults [id]          Show global provider defaults

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

  wopr security status                       Show security status and enforcement mode
  wopr security enforcement <mode>           Set enforcement mode (off|warn|enforce)

  wopr security sessions                     List all session security configs
  wopr security session <name>               Show session security config
  wopr security session <name> <prop> <val>  Set session property
    Properties:
      indexable <patterns>  What transcripts this session can see in search
      access <patterns>     Who can inject into this session
      capabilities <caps>   What this session can do
    Examples:
      wopr security session main indexable "*"              # See all transcripts
      wopr security session p2p-alice indexable self        # Only own transcripts
      wopr security session gateway access "trust:untrusted"  # Allow untrusted
      wopr security session main capabilities "*"           # Full capabilities

  wopr security p2p                          Show P2P security settings
  wopr security p2p discovery-trust <level>  Set trust for discovered peers
  wopr security p2p auto-accept <true|false> Enable/disable auto-accept

  wopr security audit                        Show audit settings
  wopr security audit enable                 Enable audit logging
  wopr security audit disable                Disable audit logging

  wopr security sources                      List source-specific configs
  wopr security defaults                     Show default security policy

  wopr sandbox status                        Show sandbox status and containers
  wopr sandbox list                          List all sandbox containers
  wopr sandbox create <session>              Create sandbox for a session
  wopr sandbox destroy <session>             Destroy sandbox for a session
  wopr sandbox exec <session> <command>      Execute command in sandbox
  wopr sandbox prune                         Remove all idle containers
  wopr sandbox recreate <session>            Recreate container (apply config changes)

Environment:
  WOPR_HOME                              Base directory (default: ~/wopr)
  ANTHROPIC_API_KEY                      API key for Claude (Anthropic)
  OPENAI_API_KEY                         API key for Codex (OpenAI)

Supported Providers:
  anthropic                              Claude models via Agent SDK
  codex                                  OpenAI Codex agent for coding tasks

Install plugins for additional functionality:
  wopr plugin install wopr-plugin-p2p    P2P networking, identity, and peer management
  wopr plugin install wopr-plugin-discord Discord bot integration
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
          logger.info("No providers registered.");
        } else {
          logger.info("Registered providers:");
          logger.info("ID              | Name              | Available");
          logger.info("----------------|-------------------|----------");
          for (const p of providers) {
            const id = p.id.padEnd(15);
            const name = (p.name || "N/A").padEnd(19);
            const status = p.available ? "Yes" : "No";
            logger.info(`${id}| ${name}| ${status}`);
          }
        }
        break;
      }

      case "add": {
        if (!args[0]) {
          logger.error("Usage: wopr providers add <provider-id> [credential]");
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
            logger.error("Credential required");
            process.exit(1);
          }
        }

        try {
          await client.addProviderCredential(providerId, credential);
          logger.info(`Credential added for provider: ${providerId}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to add credential: ${msg}`);
          process.exit(1);
        }
        break;
      }

      case "remove": {
        if (!args[0]) {
          logger.error("Usage: wopr providers remove <provider-id>");
          process.exit(1);
        }

        const providerId = args[0];
        try {
          await providerRegistry.removeCredential(providerId);
          logger.info(`Removed credential for provider: ${providerId}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to remove credential: ${msg}`);
          process.exit(1);
        }
        break;
      }

      case "health-check": {
        logger.info("Checking provider health...");
        await client.checkProvidersHealth();

        const providers = await client.getProviders();
        const healthy = providers.filter((p: any) => p.available);
        const unhealthy = providers.filter((p: any) => !p.available);

        if (healthy.length > 0) {
          logger.info("\nHealthy:");
          for (const p of healthy) {
            logger.info(`  ${p.id}: OK`);
          }
        }

        if (unhealthy.length > 0) {
          logger.info("\nUnhealthy:");
          for (const p of unhealthy) {
            logger.info(`  ${p.id}: Not available`);
          }
        }

        if (providers.length === 0) {
          logger.info("No providers registered.");
        }
        break;
      }

      case "default": {
        if (!args[0]) {
          logger.error("Usage: wopr providers default <provider-id> [--model name] [--reasoning-effort level]");
          process.exit(1);
        }

        const providerId = args[0];
        const { flags } = parseFlags(args.slice(1));

        if (!flags.model && !flags["reasoning-effort"]) {
          logger.error("Specify at least one: --model <name> or --reasoning-effort <level>");
          process.exit(1);
        }

        // Set global provider defaults
        if (flags.model) {
          config.setProviderDefault(providerId, "model", flags.model as string);
        }
        if (flags["reasoning-effort"]) {
          config.setProviderDefault(providerId, "reasoningEffort", flags["reasoning-effort"] as string);
        }

        await config.save();

        const defaults = config.getProviderDefaults(providerId);
        logger.info(`Updated global defaults for ${providerId}:`);
        if (defaults?.model) logger.info(`  model: ${defaults.model}`);
        if (defaults?.reasoningEffort) logger.info(`  reasoningEffort: ${defaults.reasoningEffort}`);
        break;
      }

      case "show-defaults": {
        const providerId = args[0];

        if (providerId) {
          const defaults = config.getProviderDefaults(providerId);
          if (!defaults || Object.keys(defaults).length === 0) {
            logger.info(`No global defaults set for ${providerId}`);
          } else {
            logger.info(`Global defaults for ${providerId}:`);
            for (const [key, value] of Object.entries(defaults)) {
              logger.info(`  ${key}: ${value}`);
            }
          }
        } else {
          // Show all provider defaults
          const allConfig = config.get();
          if (!allConfig.providers || Object.keys(allConfig.providers).length === 0) {
            logger.info("No global provider defaults set.");
            logger.info("Set with: wopr providers default <id> --model <name>");
          } else {
            logger.info("Global provider defaults:");
            for (const [pid, defaults] of Object.entries(allConfig.providers)) {
              logger.info(`\n  ${pid}:`);
              for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
                logger.info(`    ${key}: ${value}`);
              }
            }
          }
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
          logger.error("Usage: wopr session create <name> [context] [--provider <id>] [--fallback chain]");
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

          logger.info(
            `Created session "${name}" with provider: ${flags.provider}${
              flags.fallback ? ` (fallback: ${flags.fallback})` : ""
            }`
          );
        } else {
          logger.info(`Created session "${name}"`);
        }
        break;
      }

      case "set-provider": {
        if (!args[0] || !args[1]) {
          logger.error("Usage: wopr session set-provider <name> <provider-id> [--model name] [--fallback chain]");
          process.exit(1);
        }

        const { flags } = parseFlags(args.slice(2));
        const sessionName = args[0];
        const providerId = args[1];

        // Verify session exists
        try {
          await client.getSession(sessionName);
        } catch (error) {
          logger.error(`Session not found: ${sessionName}`);
          process.exit(1);
        }

        const providerConfig: { name: string; model?: string; fallback?: string[] } = {
          name: providerId,
        };
        if (flags.model) {
          providerConfig.model = flags.model as string;
        }
        if (flags.fallback) {
          providerConfig.fallback = (flags.fallback as string).split(",").map(s => s.trim());
        }

        // Save provider config
        const { SESSIONS_DIR } = await import("./paths.js");
        const providerFile = (await import("path")).join(SESSIONS_DIR, `${sessionName}.provider.json`);
        await (await import("fs/promises")).writeFile(providerFile, JSON.stringify(providerConfig, null, 2));

        const extras: string[] = [];
        if (flags.model) extras.push(`model: ${flags.model}`);
        if (flags.fallback) extras.push(`fallback: ${flags.fallback}`);
        logger.info(
          `Updated session "${sessionName}" provider to: ${providerId}${
            extras.length > 0 ? ` (${extras.join(", ")})` : ""
          }`
        );
        break;
      }
      case "inject":
        if (!args[0] || !args[1]) {
          logger.error("Usage: wopr session inject <name> <message>");
          process.exit(1);
        }
        logger.info(`[wopr] Injecting into session: ${args[0]}`);
        await client.inject(args[0], args.slice(1).join(" "), (msg) => {
          if (msg.type === "text") {
            process.stdout.write(msg.content);
          } else if (msg.type === "tool_use") {
            logger.info(`\n[tool] ${msg.toolName}`);
          } else if (msg.type === "complete") {
            logger.info(`\n[wopr] ${msg.content}`);
          } else if (msg.type === "error") {
            logger.error(`\n[wopr] Error: ${msg.content}`);
          }
        });
        break;
      case "log":
        if (!args[0] || !args[1]) {
          logger.error("Usage: wopr session log <name> <message>");
          process.exit(1);
        }
        await client.logMessage(args[0], args.slice(1).join(" "));
        logger.info(`[wopr] Logged message to session: ${args[0]}`);
        break;
      case "list": {
        const sessions = await client.getSessions();
        if (sessions.length === 0) {
          logger.info("No sessions.");
        } else {
          logger.info("Sessions:");
          for (const s of sessions) {
            logger.info(`  ${s.name}${s.hasContext ? " (has context)" : ""}`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          logger.error("Usage: wopr session show <name> [--limit N]");
          process.exit(1);
        }
        const session = await client.getSession(args[0]);
        logger.info(`Session: ${session.name}`);
        logger.info(`ID: ${session.id || "(not started)"}`);
        if (session.context) logger.info(`\n--- Context ---\n${session.context}\n--- End ---`);

        // Show conversation history
        const limitIndex = args.indexOf("--limit");
        const limit = limitIndex !== -1 && args[limitIndex + 1] ? parseInt(args[limitIndex + 1], 10) : 20;
        const history = await client.getConversationHistory(args[0], limit);

        if (history.entries.length > 0) {
          logger.info(`\n--- Conversation History (last ${history.count} entries) ---`);
          for (const entry of history.entries) {
            const timestamp = new Date(entry.ts).toLocaleTimeString();
            const prefix = entry.type === "context" ? "[context]" :
                          entry.type === "response" ? "[WOPR]" :
                          `[${entry.from}]`;
            // Truncate long messages for readability
            const content = entry.content.length > 200 ?
              entry.content.substring(0, 200) + "..." :
              entry.content;
            logger.info(`${timestamp} ${prefix}: ${content}`);
          }
          logger.info(`--- End History ---`);
        } else {
          logger.info("\nNo conversation history yet.");
        }
        break;
      }
      case "delete": {
        if (!args[0]) {
          logger.error("Usage: wopr session delete <name>");
          process.exit(1);
        }
        await client.deleteSession(args[0]);
        logger.info(`Deleted session "${args[0]}"`);
        break;
      }
      case "init-docs": {
        if (!args[0]) {
          logger.error("Usage: wopr session init-docs <name> [--agent-name <name>] [--user-name <name>]");
          process.exit(1);
        }
        const sessionName = args[0];
        const agentNameFlag = args.indexOf("--agent-name");
        const userNameFlag = args.indexOf("--user-name");
        const agentName = agentNameFlag >= 0 ? args[agentNameFlag + 1] : undefined;
        const userName = userNameFlag >= 0 ? args[userNameFlag + 1] : undefined;
        
        // Call daemon API to initialize self-doc files
        try {
          const result = await client.initSessionDocs(sessionName, { agentName, userName });
          logger.info(`Initialized self-documentation files for session "${sessionName}":`);
          for (const file of result.created) {
            logger.info(`  - ${file}`);
          }
          logger.info("\nEdit these files in ~/.wopr/sessions/" + sessionName + "/");
          logger.info("They will be automatically loaded into context on each injection.");
        } catch (err: any) {
          logger.error(`Failed to init docs: ${err.message}`);
          process.exit(1);
        }
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
            logger.info("No registries. Add: wopr skill registry add <name> <url>");
          } else {
            logger.info("Registries:");
            for (const r of registries) logger.info(`  ${r.name}: ${r.url}`);
          }
          break;
        }
        case "add":
          if (!args[1] || !args[2]) {
            logger.error("Usage: wopr skill registry add <name> <url>");
            process.exit(1);
          }
          await client.addSkillRegistry(args[1], args[2]);
          logger.info(`Added registry: ${args[1]}`);
          break;
        case "remove":
          if (!args[1]) {
            logger.error("Usage: wopr skill registry remove <name>");
            process.exit(1);
          }
          await client.removeSkillRegistry(args[1]);
          logger.info(`Removed registry: ${args[1]}`);
          break;
        default:
          help();
      }
    } else {
      switch (subcommand) {
        case "list": {
          const skills = await client.getSkills();
          if (skills.length === 0) {
            logger.info(`No skills. Add to ${SKILLS_DIR}/<name>/SKILL.md`);
          } else {
            logger.info("Skills:");
            for (const s of skills) logger.info(`  ${s.name} - ${s.description}`);
          }
          break;
        }
        case "search": {
          if (!args[0]) {
            logger.error("Usage: wopr skill search <query>");
            process.exit(1);
          }
          const results = await client.searchSkills(args.join(" "));
          if (results.length === 0) {
            logger.info(`No skills found matching "${args.join(" ")}"`);
          } else {
            logger.info(`Found ${results.length} skill(s):`);
            for (const result of results) {
              logger.info(`  ${result.skill.name} (${result.registry})`);
              logger.info(`    ${result.skill.description || "No description"}`);
              logger.info(`    wopr skill install ${result.skill.source}`);
            }
          }
          break;
        }
        case "install": {
          if (!args[0]) {
            logger.error("Usage: wopr skill install <source> [name]");
            process.exit(1);
          }
          logger.info(`Installing...`);
          await client.installSkill(args[0], args[1]);
          logger.info(`Installed: ${args[1] || args[0]}`);
          break;
        }
        case "create": {
          if (!args[0]) {
            logger.error("Usage: wopr skill create <name> [description]");
            process.exit(1);
          }
          await client.createSkill(args[0], args.slice(1).join(" ") || undefined);
          logger.info(`Created: ${join(SKILLS_DIR, args[0], "SKILL.md")}`);
          break;
        }
        case "remove": {
          if (!args[0]) {
            logger.error("Usage: wopr skill remove <name>");
            process.exit(1);
          }
          await client.removeSkill(args[0]);
          logger.info(`Removed: ${args[0]}`);
          break;
        }
        case "cache":
          if (args[0] === "clear") {
            await client.clearSkillCache();
            logger.info("Cache cleared");
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
          logger.error("Usage: wopr cron add <name> <schedule> <session> <message>");
          process.exit(1);
        }
        await client.addCron({
          name: filtered[0],
          schedule: filtered[1],
          session: filtered[2],
          message: filtered.slice(3).join(" "),
          once: flags.once || undefined,
        });
        logger.info(`Added cron: ${filtered[0]}`);
        if (flags.now) {
          await client.inject(filtered[2], filtered.slice(3).join(" "), (msg) => {
            if (msg.type === "text") process.stdout.write(msg.content);
          });
        }
        break;
      }
      case "once": {
        if (args.length < 3) {
          logger.error("Usage: wopr cron once <time> <session> <message>");
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
        logger.info(`Scheduled for ${new Date(runAt).toLocaleString()}`);
        break;
      }
      case "now":
        if (args.length < 2) {
          logger.error("Usage: wopr cron now <session> <message>");
          process.exit(1);
        }
        await client.inject(args[0], args.slice(1).join(" "), (msg) => {
          if (msg.type === "text") process.stdout.write(msg.content);
          else if (msg.type === "complete") logger.info(`\n[wopr] ${msg.content}`);
        });
        break;
      case "remove": {
        if (!args[0]) {
          logger.error("Usage: wopr cron remove <name>");
          process.exit(1);
        }
        await client.removeCron(args[0]);
        logger.info(`Removed: ${args[0]}`);
        break;
      }
      case "list": {
        const crons = await client.getCrons();
        if (crons.length === 0) {
          logger.info("No crons.");
        } else {
          logger.info("Crons:");
          for (const c of crons) {
            if (c.runAt) {
              logger.info(`  ${c.name}: once @ ${new Date(c.runAt).toLocaleString()}`);
            } else {
              logger.info(`  ${c.name}: ${c.schedule}${c.once ? " (one-time)" : ""}`);
            }
            logger.info(`    -> ${c.session}: "${c.message}"`);
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
            logger.error(`Config key "${args[0]}" not found`);
            process.exit(1);
          }
          logger.info(JSON.stringify(value, null, 2));
        } else {
          // Show all config
          logger.info(JSON.stringify(config.get(), null, 2));
        }
        break;
      }
      case "set": {
        if (!args[0] || args[1] === undefined) {
          logger.error("Usage: wopr config set <key> <value>");
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
        logger.info(`Set ${key} = ${JSON.stringify(value)}`);
        break;
      }
      case "reset": {
        config.reset();
        await config.save();
        logger.info("Config reset to defaults");
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
          logger.info(`Daemon already running (PID ${existing})`);
          return;
        }
        const script = process.argv[1];
        const child = execSync(`nohup npx tsx "${script}" daemon run > /dev/null 2>&1 & echo $!`, {
          encoding: "utf-8",
          shell: "/bin/bash",
        });
        logger.info(`Daemon started (PID ${child.trim()})`);
        break;
      }
      case "stop": {
        const pid = getDaemonPid();
        if (!pid) {
          logger.info("Daemon not running");
          return;
        }
        process.kill(pid, "SIGTERM");
        logger.info(`Daemon stopped (PID ${pid})`);
        break;
      }
      case "status": {
        const pid = getDaemonPid();
        logger.info(pid ? `Daemon running (PID ${pid})` : "Daemon not running");
        break;
      }
      case "run":
        // Run the daemon directly (used by daemon start)
        const { startDaemon } = await import("./daemon/index.js");
        await startDaemon();
        break;
      case "logs":
        if (existsSync(LOG_FILE)) {
          logger.info(readFileSync(LOG_FILE, "utf-8"));
        } else {
          logger.info("No logs");
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
        logger.info("Auth: Claude Code OAuth (shared credentials)");
        logger.info("Source: ~/.claude/.credentials.json");
        if (claudeCodeAuth.expiresAt) {
          const exp = new Date(claudeCodeAuth.expiresAt);
          const now = Date.now();
          if (claudeCodeAuth.expiresAt > now) {
            logger.info(`Expires: ${exp.toLocaleString()}`);
          } else {
            logger.info(`Expired: ${exp.toLocaleString()} (will auto-refresh)`);
          }
        }
      } else if (!auth || (!auth.apiKey && !auth.accessToken)) {
        logger.info("Not authenticated");
        logger.info("\nLogin with Claude Max/Pro:");
        logger.info("  wopr auth login");
        logger.info("\nOr use an API key:");
        logger.info("  wopr auth api-key <your-key>");
      } else if (auth.type === "oauth") {
        logger.info("Auth: OAuth (Claude Max/Pro)");
        if (auth.email) logger.info(`Email: ${auth.email}`);
        if (auth.expiresAt) {
          logger.info(`Expires: ${new Date(auth.expiresAt).toLocaleString()}`);
        }
      } else if (auth.type === "api_key") {
        logger.info("Auth: API Key");
        logger.info(`Key: ${auth.apiKey?.substring(0, 12)}...`);
      }
    } else if (subcommand === "login") {
      const pkce = generatePKCE();
      const redirectUri = "http://localhost:9876/callback";
      const authUrl = buildAuthUrl(pkce, redirectUri);

      logger.info("Opening browser for authentication...\n");
      logger.info("If browser doesn't open, visit:");
      logger.info(authUrl);
      logger.info("\nWaiting for authentication...");

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
            logger.error("Error: Invalid state parameter");
            process.exit(1);
          }

          try {
            const tokens = await exchangeCode(code, pkce.codeVerifier, redirectUri);
            saveOAuthTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresIn);

            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Success!</h1><p>You can close this window.</p></body></html>");
            server.close();

            logger.info("\nAuthenticated successfully!");
            logger.info("Your Claude Max/Pro subscription is now linked.");
            process.exit(0);
          } catch (err: any) {
            res.writeHead(500);
            res.end(`Error: ${err.message}`);
            server.close();
            logger.error("Error:", err.message);
            process.exit(1);
          }
        }
      });

      server.listen(9876, () => {
        const open = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execSync(`${open} "${authUrl}"`, { stdio: "ignore" });
      });

      setTimeout(() => {
        logger.error("\nTimeout waiting for authentication");
        server.close();
        process.exit(1);
      }, 5 * 60 * 1000);
    } else if (subcommand === "api-key") {
      if (!args[0]) {
        logger.error("Usage: wopr auth api-key <your-api-key>");
        process.exit(1);
      }
      saveApiKey(args[0]);
      logger.info("API key saved");
    } else if (subcommand === "logout") {
      clearAuth();
      logger.info("Logged out");
    } else {
      help();
    }
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
            logger.info("No plugin registries.");
          } else {
            logger.info("Plugin registries:");
            for (const r of registries) logger.info(`  ${r.name}: ${r.url}`);
          }
          break;
        }
        case "add":
          if (!args[1] || !args[2]) {
            logger.error("Usage: wopr plugin registry add <name> <url>");
            process.exit(1);
          }
          await client.addPluginRegistry(args[1], args[2]);
          logger.info(`Added registry: ${args[1]}`);
          break;
        case "remove":
          if (!args[1]) {
            logger.error("Usage: wopr plugin registry remove <name>");
            process.exit(1);
          }
          await client.removePluginRegistry(args[1]);
          logger.info(`Removed registry: ${args[1]}`);
          break;
        default:
          help();
      }
    } else {
      switch (subcommand) {
        case "list": {
          const plugins = await client.getPlugins();
          if (plugins.length === 0) {
            logger.info("No plugins installed. Install: wopr plugin install <source>");
          } else {
            logger.info("Installed plugins:");
            for (const p of plugins) {
              const status = p.enabled ? "enabled" : "disabled";
              logger.info(`  ${p.name} v${p.version} (${p.source}, ${status})`);
              if (p.description) logger.info(`    ${p.description}`);
            }
          }
          break;
        }
        case "install": {
          if (!args[0]) {
            logger.error("Usage: wopr plugin install <source>");
            logger.error("  npm:      wopr plugin install wopr-plugin-discord");
            logger.error("  npm:      wopr plugin install wopr-p2p");
            logger.error("  github:   wopr plugin install github:user/wopr-discord");
            logger.error("  local:    wopr plugin install ./my-plugin");
            process.exit(1);
          }
          await client.installPlugin(args[0]);
          logger.info(`Installed`);
          break;
        }
        case "remove": {
          if (!args[0]) {
            logger.error("Usage: wopr plugin remove <name>");
            process.exit(1);
          }
          await client.removePlugin(args[0]);
          logger.info(`Removed: ${args[0]}`);
          break;
        }
        case "enable": {
          if (!args[0]) {
            logger.error("Usage: wopr plugin enable <name>");
            process.exit(1);
          }
          await client.enablePlugin(args[0]);
          logger.info(`Enabled: ${args[0]}`);
          break;
        }
        case "disable": {
          if (!args[0]) {
            logger.error("Usage: wopr plugin disable <name>");
            process.exit(1);
          }
          await client.disablePlugin(args[0]);
          logger.info(`Disabled: ${args[0]}`);
          break;
        }
        case "search": {
          if (!args[0]) {
            logger.error("Usage: wopr plugin search <query>");
            process.exit(1);
          }
          logger.info(`Searching npm for wopr-plugin-${args[0]}...`);
          const results = await client.searchPlugins(args[0]);
          if (results.length === 0) {
            logger.info("No plugins found.");
          } else {
            logger.info("Found plugins:");
            for (const r of results) {
              logger.info(`  ${r.name} - ${r.description || ""}`);
              logger.info(`    wopr plugin install ${r.name}`);
            }
          }
          break;
        }
        default:
          help();
      }
    }
  } else if (command === "init") {
    // Interactive onboarding wizard
    const readline = await import("readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    logger.info("=== WOPR Configuration Wizard ===\n");

    // Load existing config
    await config.load();
    const existing = config.get();

    // Daemon settings
    logger.info("Daemon Settings:");
    const port = await rl.question(`  Port [${existing.daemon.port}]: `);
    if (port) config.setValue("daemon.port", parseInt(port) || existing.daemon.port);

    const host = await rl.question(`  Host [${existing.daemon.host}]: `);
    if (host) config.setValue("daemon.host", host);

    const autoStart = await rl.question(`  Auto-start daemon? (y/n) [${existing.daemon.autoStart ? "y" : "n"}]: `);
    if (autoStart) config.setValue("daemon.autoStart", autoStart.toLowerCase() === "y");

    // Anthropic API Key
    logger.info("\nAnthropic:");
    const hasKey = existing.anthropic.apiKey ? "(configured)" : "(not set)";
    const apiKey = await rl.question(`  API Key ${hasKey}: `);
    if (apiKey) config.setValue("anthropic.apiKey", apiKey);

    // OAuth
    logger.info("\nOAuth (for claude.ai login):");
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
    logger.info("\nDiscord Bot (optional):");
    const hasDiscord = existing.discord?.token ? "(configured)" : "(not set)";
    const discordToken = await rl.question(`  Bot Token ${hasDiscord}: `);
    if (discordToken) {
      config.setValue("discord.token", discordToken);
      const guildId = await rl.question("  Guild ID (optional): ");
      if (guildId) config.setValue("discord.guildId", guildId);
    }

    // Discovery
    logger.info("\nDiscovery:");
    const topics = await rl.question(`  Auto-join topics (comma-separated) [${existing.discovery.topics.join(",")}]: `);
    if (topics) config.setValue("discovery.topics", topics.split(",").map(t => t.trim()));

    const autoJoin = await rl.question(`  Auto-join on startup? (y/n) [${existing.discovery.autoJoin ? "y" : "n"}]: `);
    if (autoJoin) config.setValue("discovery.autoJoin", autoJoin.toLowerCase() === "y");

    // Save
    await config.save();
    rl.close();

    logger.info("\n✓ Configuration saved!");
    logger.info(`  Config file: ~/wopr/config.json`);
    logger.info("\nNext steps:");
    logger.info("  wopr daemon start    # Start the daemon");
    logger.info("  wopr session create  # Create a session");
  } else if (command === "middleware") {
    await requireDaemon();
    switch (subcommand) {
      case "list": {
        const middlewares = await client.getMiddlewares();
        if (middlewares.length === 0) {
          logger.info("No middleware registered.");
        } else {
          logger.info("Middlewares:");
          logger.info("Name              | Priority | Enabled | Hooks");
          logger.info("------------------|----------|---------|-------");
          for (const m of middlewares) {
            const name = m.name.padEnd(17);
            const priority = m.priority.toString().padEnd(8);
            const enabled = (m.enabled ? "yes" : "no").padEnd(7);
            const hooks = [];
            if (m.hasIncoming) hooks.push("in");
            if (m.hasOutgoing) hooks.push("out");
            logger.info(`${name}| ${priority}| ${enabled}| ${hooks.join(",") || "-"}`);
          }
        }
        break;
      }
      case "chain": {
        const chain = await client.getMiddlewareChain();
        if (chain.length === 0) {
          logger.info("No middleware in chain.");
        } else {
          logger.info("Middleware chain (execution order):");
          for (let i = 0; i < chain.length; i++) {
            const m = chain[i];
            const status = m.enabled ? "✓" : "✗";
            logger.info(`  ${i + 1}. [${status}] ${m.name} (priority: ${m.priority})`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          logger.error("Usage: wopr middleware show <name>");
          process.exit(1);
        }
        try {
          const m = await client.getMiddleware(args[0]);
          logger.info(`Middleware: ${m.name}`);
          logger.info(`  Priority: ${m.priority}`);
          logger.info(`  Enabled: ${m.enabled ? "yes" : "no"}`);
          logger.info(`  Incoming hook: ${m.hasIncoming ? "yes" : "no"}`);
          logger.info(`  Outgoing hook: ${m.hasOutgoing ? "yes" : "no"}`);
        } catch (err: any) {
          logger.error(`Middleware not found: ${args[0]}`);
          process.exit(1);
        }
        break;
      }
      case "enable": {
        if (!args[0]) {
          logger.error("Usage: wopr middleware enable <name>");
          process.exit(1);
        }
        await client.enableMiddleware(args[0]);
        logger.info(`Enabled middleware: ${args[0]}`);
        break;
      }
      case "disable": {
        if (!args[0]) {
          logger.error("Usage: wopr middleware disable <name>");
          process.exit(1);
        }
        await client.disableMiddleware(args[0]);
        logger.info(`Disabled middleware: ${args[0]}`);
        break;
      }
      case "priority": {
        if (!args[0] || args[1] === undefined) {
          logger.error("Usage: wopr middleware priority <name> <priority>");
          logger.error("  Lower priority runs first (default: 100)");
          process.exit(1);
        }
        const priority = parseInt(args[1], 10);
        if (isNaN(priority)) {
          logger.error("Priority must be a number");
          process.exit(1);
        }
        await client.setMiddlewarePriority(args[0], priority);
        logger.info(`Set ${args[0]} priority to ${priority}`);
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
          logger.info("No context providers registered.");
        } else {
          logger.info("Context providers:");
          logger.info("Name              | Priority | Enabled");
          logger.info("------------------|----------|--------");
          for (const p of providers) {
            const name = p.name.padEnd(17);
            const priority = p.priority.toString().padEnd(8);
            const enabled = p.enabled ? "yes" : "no";
            logger.info(`${name}| ${priority}| ${enabled}`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          logger.error("Usage: wopr context show <name>");
          process.exit(1);
        }
        try {
          const p = await client.getContextProvider(args[0]);
          logger.info(`Context provider: ${p.name}`);
          logger.info(`  Priority: ${p.priority}`);
          logger.info(`  Enabled: ${p.enabled ? "yes" : "no"}`);
        } catch (err: any) {
          logger.error(`Context provider not found: ${args[0]}`);
          process.exit(1);
        }
        break;
      }
      case "enable": {
        if (!args[0]) {
          logger.error("Usage: wopr context enable <name>");
          process.exit(1);
        }
        await client.enableContextProvider(args[0]);
        logger.info(`Enabled context provider: ${args[0]}`);
        break;
      }
      case "disable": {
        if (!args[0]) {
          logger.error("Usage: wopr context disable <name>");
          process.exit(1);
        }
        await client.disableContextProvider(args[0]);
        logger.info(`Disabled context provider: ${args[0]}`);
        break;
      }
      case "priority": {
        if (!args[0] || args[1] === undefined) {
          logger.error("Usage: wopr context priority <name> <priority>");
          logger.error("  Lower priority runs first (appears earlier in context)");
          process.exit(1);
        }
        const priority = parseInt(args[1], 10);
        if (isNaN(priority)) {
          logger.error("Priority must be a number");
          process.exit(1);
        }
        await client.setContextProviderPriority(args[0], priority);
        logger.info(`Set ${args[0]} priority to ${priority}`);
        break;
      }
      default:
        help();
    }
  } else if (command === "security") {
    // Security configuration commands
    const { getSecurityConfig, saveSecurityConfig, CAPABILITY_PROFILES, DEFAULT_SANDBOX_BY_TRUST } = await import("./security/index.js");

    if (subcommand === "status") {
      // Show overall security status
      const config = getSecurityConfig();
      logger.info("WOPR Security Status");
      logger.info("====================");
      logger.info(`Enforcement: ${config.enforcement}`);
      logger.info(`Default access: ${(config.defaultAccess || ["trust:trusted"]).join(", ")}`);
      logger.info(`Sessions configured: ${Object.keys(config.sessions || {}).length}`);
      logger.info(`Audit enabled: ${config.audit?.enabled ?? false}`);
      if (config.p2p) {
        logger.info(`P2P discovery trust: ${config.p2p.discoveryTrust}`);
        logger.info(`P2P auto-accept: ${config.p2p.autoAccept}`);
      }
    } else if (subcommand === "enforcement") {
      const mode = args[0];
      if (!mode) {
        const config = getSecurityConfig();
        logger.info(`Current enforcement mode: ${config.enforcement}`);
        logger.info("Modes: off, warn, enforce");
      } else if (mode === "off" || mode === "warn" || mode === "enforce") {
        const config = getSecurityConfig();
        config.enforcement = mode;
        saveSecurityConfig(config);
        logger.info(`Enforcement mode set to: ${mode}`);
      } else {
        logger.error("Invalid mode. Use: off, warn, or enforce");
        process.exit(1);
      }
    } else if (subcommand === "sessions") {
      // List all session security configs
      const config = getSecurityConfig();
      const sessions = config.sessions || {};
      const sessionNames = Object.keys(sessions);

      if (sessionNames.length === 0) {
        logger.info("No session security configs defined.");
        logger.info("Sessions inherit defaults based on trust level.");
      } else {
        logger.info("Session security configs:");
        logger.info("Session           | Access                    | Indexable           | Capabilities");
        logger.info("------------------|---------------------------|---------------------|------------------");
        for (const name of sessionNames) {
          const sess = sessions[name];
          const access = sess.access?.join(",") || "(default)";
          const indexable = sess.indexable?.join(",") || "(default)";
          const caps = sess.capabilities?.join(",") || "(default)";
          logger.info(`${name.padEnd(17)} | ${access.padEnd(25)} | ${indexable.padEnd(19)} | ${caps}`);
        }
      }
    } else if (subcommand === "session") {
      const sessionName = args[0];
      if (!sessionName) {
        logger.error("Usage: wopr security session <name> [property <value>]");
        process.exit(1);
      }

      const property = args[1];
      const value = args[2];

      if (!property) {
        // Show session security config
        const config = getSecurityConfig();
        const sess = config.sessions?.[sessionName];

        if (!sess) {
          logger.info(`Session "${sessionName}" has no explicit security config.`);
          logger.info("It inherits defaults based on trust level:");
          logger.info("  owner/trusted: indexable=[*], access=[trust:trusted]");
          logger.info("  semi-trusted/untrusted: indexable=[self]");
        } else {
          logger.info(`Session: ${sessionName}`);
          if (sess.access) logger.info(`  access: ${sess.access.join(", ")}`);
          if (sess.capabilities) logger.info(`  capabilities: ${sess.capabilities.join(", ")}`);
          if (sess.indexable) logger.info(`  indexable: ${sess.indexable.join(", ")}`);
          if (sess.sandbox) logger.info(`  sandbox: ${JSON.stringify(sess.sandbox)}`);
          if (sess.prompt) logger.info(`  prompt: ${sess.prompt.slice(0, 50)}...`);
          if (sess.description) logger.info(`  description: ${sess.description}`);
        }
      } else if (property === "indexable" || property === "access" || property === "capabilities") {
        if (!value) {
          logger.error(`Usage: wopr security session <name> ${property} <patterns>`);
          logger.error(`  ${property}: comma-separated list`);
          process.exit(1);
        }

        // Parse patterns (comma-separated)
        const patterns = value.split(",").map(p => p.trim()).filter(Boolean);

        // Update security config
        const config = getSecurityConfig();
        if (!config.sessions) config.sessions = {};
        if (!config.sessions[sessionName]) config.sessions[sessionName] = {};
        (config.sessions[sessionName] as any)[property] = patterns;
        saveSecurityConfig(config);

        logger.info(`Set ${property} for "${sessionName}" to: ${patterns.join(", ")}`);
      } else if (property === "delete" || property === "remove") {
        // Remove session config
        const config = getSecurityConfig();
        if (config.sessions?.[sessionName]) {
          delete config.sessions[sessionName];
          saveSecurityConfig(config);
          logger.info(`Removed security config for session "${sessionName}"`);
        } else {
          logger.info(`Session "${sessionName}" has no explicit config to remove.`);
        }
      } else {
        logger.error(`Unknown property: ${property}`);
        logger.error("Supported properties: indexable, access, capabilities, delete");
        process.exit(1);
      }
    } else if (subcommand === "p2p") {
      const config = getSecurityConfig();
      const setting = args[0];
      const value = args[1];

      if (!setting) {
        // Show P2P security settings
        logger.info("P2P Security Settings:");
        logger.info(`  discovery-trust: ${config.p2p?.discoveryTrust ?? "untrusted"}`);
        logger.info(`  auto-accept: ${config.p2p?.autoAccept ?? false}`);
        logger.info(`  key-rotation-grace-hours: ${config.p2p?.keyRotationGraceHours ?? 24}`);
        logger.info(`  max-payload-size: ${config.p2p?.maxPayloadSize ?? 1048576} bytes`);
      } else if (setting === "discovery-trust") {
        if (!value) {
          logger.info(`Current discovery trust: ${config.p2p?.discoveryTrust ?? "untrusted"}`);
        } else if (["owner", "trusted", "semi-trusted", "untrusted"].includes(value)) {
          if (!config.p2p) config.p2p = { discoveryTrust: "untrusted", autoAccept: false };
          config.p2p.discoveryTrust = value as any;
          saveSecurityConfig(config);
          logger.info(`Set P2P discovery trust to: ${value}`);
        } else {
          logger.error("Invalid trust level. Use: owner, trusted, semi-trusted, untrusted");
          process.exit(1);
        }
      } else if (setting === "auto-accept") {
        if (!value) {
          logger.info(`Current auto-accept: ${config.p2p?.autoAccept ?? false}`);
        } else {
          const enabled = value === "true" || value === "yes" || value === "1";
          if (!config.p2p) config.p2p = { discoveryTrust: "untrusted", autoAccept: false };
          config.p2p.autoAccept = enabled;
          saveSecurityConfig(config);
          logger.info(`Set P2P auto-accept to: ${enabled}`);
        }
      } else {
        logger.error("Unknown P2P setting. Use: discovery-trust, auto-accept");
        process.exit(1);
      }
    } else if (subcommand === "audit") {
      const config = getSecurityConfig();
      const action = args[0];

      if (!action) {
        // Show audit settings
        logger.info("Audit Settings:");
        logger.info(`  enabled: ${config.audit?.enabled ?? false}`);
        logger.info(`  log-success: ${config.audit?.logSuccess ?? false}`);
        logger.info(`  log-denied: ${config.audit?.logDenied ?? true}`);
        logger.info(`  log-path: ${config.audit?.logPath ?? "(default)"}`);
      } else if (action === "enable") {
        if (!config.audit) config.audit = { enabled: false };
        config.audit.enabled = true;
        saveSecurityConfig(config);
        logger.info("Audit logging enabled.");
      } else if (action === "disable") {
        if (!config.audit) config.audit = { enabled: false };
        config.audit.enabled = false;
        saveSecurityConfig(config);
        logger.info("Audit logging disabled.");
      } else if (action === "log-success") {
        const value = args[1];
        if (!config.audit) config.audit = { enabled: false };
        config.audit.logSuccess = value === "true" || value === "yes" || value === "1";
        saveSecurityConfig(config);
        logger.info(`Audit log-success set to: ${config.audit.logSuccess}`);
      } else if (action === "log-denied") {
        const value = args[1];
        if (!config.audit) config.audit = { enabled: false };
        config.audit.logDenied = value === "true" || value === "yes" || value === "1";
        saveSecurityConfig(config);
        logger.info(`Audit log-denied set to: ${config.audit.logDenied}`);
      } else {
        logger.error("Unknown audit action. Use: enable, disable, log-success, log-denied");
        process.exit(1);
      }
    } else if (subcommand === "sources") {
      // List source-specific configs (these come from P2P plugin syncing)
      const config = getSecurityConfig();
      const sources = (config as any).sources || {};
      const sourceNames = Object.keys(sources);

      if (sourceNames.length === 0) {
        logger.info("No source-specific security configs defined.");
        logger.info("Sources use defaults based on type (cli, p2p, plugin, etc.).");
      } else {
        logger.info("Source security configs:");
        logger.info("Source                                      | Type  | Trust       | Sessions");
        logger.info("--------------------------------------------|-------|-------------|------------------");
        for (const name of sourceNames) {
          const src = sources[name];
          const type = src.type || "?";
          const trust = src.trust || "?";
          const sessions = src.sessions?.join(",") || "(any)";
          logger.info(`${name.slice(0, 43).padEnd(43)} | ${type.padEnd(5)} | ${trust.padEnd(11)} | ${sessions}`);
        }
      }
    } else if (subcommand === "defaults") {
      // Show default security policy
      const config = getSecurityConfig();
      logger.info("Default Security Policy:");
      logger.info(`  Min trust level: ${config.defaults.minTrustLevel ?? "semi-trusted"}`);
      logger.info(`  Rate limit: ${config.defaults.rateLimit?.perMinute ?? 60}/min, ${config.defaults.rateLimit?.perHour ?? 1000}/hr`);
      logger.info("");
      logger.info("Trust Level Defaults:");
      for (const level of ["owner", "trusted", "semi-trusted", "untrusted"] as const) {
        const policy = config.trustLevels?.[level];
        const caps = policy?.capabilities || CAPABILITY_PROFILES[level] || [];
        const sandbox = policy?.sandbox || DEFAULT_SANDBOX_BY_TRUST[level];
        const capStr = caps.includes("*") ? "*" : caps.slice(0, 3).join(",") + (caps.length > 3 ? "..." : "");
        logger.info(`  ${level.padEnd(13)}: caps=[${capStr}], sandbox=${sandbox?.enabled ? "yes" : "no"}`);
      }
    } else {
      logger.error("Usage:");
      logger.error("  wopr security status                        Show security status");
      logger.error("  wopr security enforcement <mode>            Set enforcement mode");
      logger.error("  wopr security sessions                      List session configs");
      logger.error("  wopr security session <name>                Show session config");
      logger.error("  wopr security session <name> <prop> <val>   Set session property");
      logger.error("  wopr security p2p                           Show P2P security");
      logger.error("  wopr security p2p <setting> <value>         Set P2P setting");
      logger.error("  wopr security audit                         Show audit settings");
      logger.error("  wopr security audit <action>                Enable/disable audit");
      logger.error("  wopr security sources                       List source configs");
      logger.error("  wopr security defaults                      Show default policy");
      process.exit(1);
    }
  } else if (command === "sandbox") {
    // Sandbox management commands
    const {
      isDockerAvailable,
      listSandboxes,
      getSandboxForSession,
      destroySandbox,
      cleanupAllSandboxes,
      execInSandbox,
    } = await import("./security/index.js");
    const {
      resolveSandboxConfig,
      shouldSandbox,
      listRegistryEntries,
      removeSandboxContainer,
      removeRegistryEntry,
      ensureSandboxContainer,
    } = await import("./sandbox/index.js");

    if (subcommand === "status") {
      // Show sandbox status
      const dockerAvailable = await isDockerAvailable();
      logger.info("Sandbox Status");
      logger.info("==============");
      logger.info(`Docker available: ${dockerAvailable ? "yes" : "no"}`);

      const entries = listRegistryEntries();
      logger.info(`Active containers: ${entries.length}`);

      if (entries.length > 0) {
        logger.info("");
        logger.info("Container              | Session          | Created              | Last Used");
        logger.info("-----------------------|------------------|----------------------|--------------------");
        for (const e of entries) {
          const created = new Date(e.createdAtMs).toISOString().slice(0, 19);
          const lastUsed = new Date(e.lastUsedAtMs).toISOString().slice(0, 19);
          logger.info(
            `${e.containerName.slice(0, 22).padEnd(22)} | ` +
            `${e.sessionKey.slice(0, 16).padEnd(16)} | ` +
            `${created} | ${lastUsed}`
          );
        }
      }
    } else if (subcommand === "list") {
      // List all containers
      const entries = listRegistryEntries();
      if (entries.length === 0) {
        logger.info("No sandbox containers.");
      } else {
        for (const e of entries) {
          logger.info(`${e.containerName} (${e.sessionKey}) - image: ${e.image}`);
        }
      }
    } else if (subcommand === "create") {
      const sessionName = args[0];
      if (!sessionName) {
        logger.error("Usage: wopr sandbox create <session>");
        process.exit(1);
      }

      const dockerAvailable = await isDockerAvailable();
      if (!dockerAvailable) {
        logger.error("Docker is not available. Please install and start Docker.");
        process.exit(1);
      }

      const cfg = resolveSandboxConfig({ sessionName });
      if (cfg.mode === "off") {
        logger.warn("Sandbox mode is 'off'. Set sandbox.mode in config to 'all' or 'non-main'.");
      }

      logger.info(`Creating sandbox for session: ${sessionName}`);
      const sandbox = await getSandboxForSession(sessionName);
      if (sandbox) {
        logger.info(`Sandbox created: ${sandbox.containerName}`);
        logger.info(`  Workspace: ${sandbox.workspaceDir}`);
        logger.info(`  Container workdir: ${sandbox.containerWorkdir}`);
      } else {
        logger.info("Session is not configured for sandboxing.");
      }
    } else if (subcommand === "destroy") {
      const sessionName = args[0];
      if (!sessionName) {
        logger.error("Usage: wopr sandbox destroy <session>");
        process.exit(1);
      }

      await destroySandbox(sessionName);
      logger.info(`Sandbox destroyed for session: ${sessionName}`);
    } else if (subcommand === "exec") {
      const sessionName = args[0];
      const command = args.slice(1).join(" ");
      if (!sessionName || !command) {
        logger.error("Usage: wopr sandbox exec <session> <command>");
        process.exit(1);
      }

      const result = await execInSandbox(sessionName, command);
      if (!result) {
        logger.error(`Session ${sessionName} is not sandboxed.`);
        process.exit(1);
      }

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      process.exit(result.exitCode);
    } else if (subcommand === "prune") {
      logger.info("Removing all sandbox containers...");
      await cleanupAllSandboxes();
      logger.info("Done.");
    } else if (subcommand === "recreate") {
      const sessionName = args[0];
      if (!sessionName) {
        logger.error("Usage: wopr sandbox recreate <session>");
        process.exit(1);
      }

      // Destroy and recreate
      await destroySandbox(sessionName);
      const sandbox = await getSandboxForSession(sessionName);
      if (sandbox) {
        logger.info(`Sandbox recreated: ${sandbox.containerName}`);
      } else {
        logger.info("Session is not configured for sandboxing.");
      }
    } else {
      logger.error("Usage:");
      logger.error("  wopr sandbox status                   Show sandbox status");
      logger.error("  wopr sandbox list                     List containers");
      logger.error("  wopr sandbox create <session>         Create sandbox");
      logger.error("  wopr sandbox destroy <session>        Destroy sandbox");
      logger.error("  wopr sandbox exec <session> <cmd>     Execute in sandbox");
      logger.error("  wopr sandbox prune                    Remove all containers");
      logger.error("  wopr sandbox recreate <session>       Recreate container");
      process.exit(1);
    }
  } else if (command === "onboard") {
    // New interactive onboarding wizard
    const { onboardCommand } = await import("./commands/onboard/index.js");
    await onboardCommand(process.argv.slice(3));
  } else if (command === "configure") {
    // Re-run onboarding wizard (alias for onboard)
    const { onboardCommand } = await import("./commands/onboard/index.js");
    await onboardCommand(process.argv.slice(3));
  } else {
    // Check for plugin commands
    const handled = await tryPluginCommand(command, [subcommand, ...args].filter(Boolean));
    if (!handled) {
      help();
    }
  }
})();

// ==================== Plugin Commands ====================

/**
 * Try to handle command via installed plugins
 */
async function tryPluginCommand(command: string, args: string[]): Promise<boolean> {
  if (!command) return false;

  const { getInstalledPlugins, loadPlugin, getLoadedPlugin } = await import("./plugins.js");
  const installed = getInstalledPlugins().filter(p => p.enabled);

  // First, load ALL enabled plugins to ensure providers/extensions are registered
  // This is necessary because provider plugins (TTS, STT) register during init
  const injectors = {
    inject: async () => "",
    getSessions: () => [],
  };

  for (const pluginInfo of installed) {
    try {
      await loadPlugin(pluginInfo, injectors, { skipRequirementsCheck: true, skipInit: true });
    } catch {
      // Plugin failed to load, continue with others
    }
  }

  // Now find and execute the command
  for (const pluginInfo of installed) {
    const loaded = getLoadedPlugin(pluginInfo.name);
    if (!loaded) continue;

    if (loaded.plugin.commands) {
      const cmd = loaded.plugin.commands.find(c => c.name === command);
      if (cmd) {
        await cmd.handler(loaded.context, args);
        return true;
      }
    }
  }

  return false;
}
