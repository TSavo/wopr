/**
 * WOPR Discord Plugin
 *
 * Talk to your WOPR sessions via Discord.
 * Manages channel mappings, user permissions, and pairing.
 */

import { Client, GatewayIntentBits, Events } from "discord.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import * as readline from "readline";

let client = null;
let ctx = null;
const pendingDiscordRequests = new Set(); // Track requests we initiated

// ============================================================================
// Pairing Requests (user-initiated, owner-approved)
// ============================================================================

function generatePairingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // No 0/O/1/I confusion
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// User requests pairing - generates a code they give to owner
function createPairingRequest(userId, userName, channelName, guildName, session) {
  const config = ctx.getConfig();
  config.pairingRequests = config.pairingRequests || {};

  // Check if user already has a pending request
  const existing = Object.entries(config.pairingRequests).find(
    ([_, req]) => req.userId === userId && req.status === "pending"
  );
  if (existing) {
    return { code: existing[0], existing: true };
  }

  const code = generatePairingCode();
  config.pairingRequests[code] = {
    userId,
    userName,
    channelName,
    guildName,
    session,  // The session they tried to access
    status: "pending",
    createdAt: Date.now(),
  };

  ctx.saveConfig(config);
  return { code, existing: false };
}

// Owner approves a pairing request
function approvePairingRequest(code, sessions) {
  const config = ctx.getConfig();
  const request = config.pairingRequests?.[code];

  if (!request) return { error: "Invalid pairing code" };
  if (request.status !== "pending") return { error: `Request already ${request.status}` };

  // Default to the session they tried to access
  const grantSessions = sessions || [request.session];

  // Create user
  config.users = config.users || {};
  config.users[request.userId] = {
    name: request.userName,
    sessions: grantSessions,
    pairedAt: Date.now(),
    pairedWith: code,
    blocked: false,
  };

  // Mark request as approved
  request.status = "approved";
  request.approvedAt = Date.now();
  request.sessions = grantSessions;

  ctx.saveConfig(config);
  return { success: true, user: request, sessions: grantSessions };
}

// Owner rejects a pairing request
function rejectPairingRequest(code, reason) {
  const config = ctx.getConfig();
  const request = config.pairingRequests?.[code];

  if (!request) return { error: "Invalid pairing code" };
  if (request.status !== "pending") return { error: `Request already ${request.status}` };

  request.status = "rejected";
  request.rejectedAt = Date.now();
  request.rejectReason = reason;

  ctx.saveConfig(config);
  return { success: true };
}

// ============================================================================
// User Management
// ============================================================================

function getUser(userId) {
  const config = ctx.getConfig();
  return config.users?.[userId];
}

function isUserAuthorized(userId, session) {
  const config = ctx.getConfig();
  const user = config.users?.[userId];

  // Check if blocked
  if (user?.blocked) return false;

  // Check if user has access to this session
  if (user?.sessions) {
    if (user.sessions.includes("*") || user.sessions.includes(session)) {
      return true;
    }
  }

  // Check default access policy
  if (config.defaultAccess === "all") return true;
  if (config.defaultAccess === "paired") return !!user;

  return false;
}

function blockUser(userId, reason) {
  const config = ctx.getConfig();
  config.users = config.users || {};
  config.users[userId] = config.users[userId] || { sessions: [] };
  config.users[userId].blocked = true;
  config.users[userId].blockedAt = Date.now();
  config.users[userId].blockReason = reason;
  ctx.saveConfig(config);
}

function unblockUser(userId) {
  const config = ctx.getConfig();
  if (config.users?.[userId]) {
    config.users[userId].blocked = false;
    delete config.users[userId].blockedAt;
    delete config.users[userId].blockReason;
    ctx.saveConfig(config);
  }
}

function grantUserAccess(userId, sessions, name) {
  const config = ctx.getConfig();
  config.users = config.users || {};
  const existing = config.users[userId];

  config.users[userId] = {
    name: name || existing?.name,
    sessions: Array.from(new Set([...(existing?.sessions || []), ...sessions])),
    grantedAt: Date.now(),
    blocked: existing?.blocked || false,
  };

  ctx.saveConfig(config);
}

function revokeUserAccess(userId, sessions) {
  const config = ctx.getConfig();
  if (!config.users?.[userId]) return;

  if (!sessions || sessions.includes("*")) {
    // Revoke all access
    delete config.users[userId];
  } else {
    // Revoke specific sessions
    config.users[userId].sessions = config.users[userId].sessions.filter(
      (s) => !sessions.includes(s)
    );
  }

  ctx.saveConfig(config);
}

// ============================================================================
// Channel Mapping
// ============================================================================

function getSessionForChannel(channel) {
  const config = ctx.getConfig();
  const channelId = channel.id;

  // Check explicit mapping
  if (config.mappings?.[channelId]) {
    return config.mappings[channelId].session;
  }

  // Auto-create mode?
  if (config.autoCreate) {
    const name = channel.name || channelId;
    const sessionName = `discord-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

    ensureSessionExists(sessionName, channel);

    // Save the mapping
    config.mappings = config.mappings || {};
    config.mappings[channelId] = {
      session: sessionName,
      channelName: channel.name || "DM",
      guildName: channel.guild?.name || "Direct Message",
      createdAt: Date.now(),
    };
    ctx.saveConfig(config);

    ctx.log.info(`Auto-mapped ${channel.name || channelId} -> ${sessionName}`);
    return sessionName;
  }

  return null;
}

function ensureSessionExists(sessionName, channel) {
  const sessionsDir = join(ctx.getPluginDir(), "..", "..", "sessions");
  const contextPath = join(sessionsDir, `${sessionName}.md`);

  if (!existsSync(contextPath)) {
    mkdirSync(sessionsDir, { recursive: true });

    const channelInfo = channel.guild
      ? `Discord server "${channel.guild.name}", channel #${channel.name}`
      : `Discord DM`;

    const context = `You are WOPR responding in ${channelInfo}.

Keep responses concise - Discord has a 2000 character limit.
Use markdown formatting (Discord supports it).
Be helpful but brief.`;

    writeFileSync(contextPath, context);
    ctx.log.info(`Created session: ${sessionName}`);
  }
}

// ============================================================================
// Message Handling
// ============================================================================

async function handleMessage(message) {
  if (message.author.bot) return;

  const config = ctx.getConfig();
  const userId = message.author.id;
  const isDM = !message.guild;
  const isMentioned = message.mentions.has(client.user);

  // Check if user is blocked
  const user = getUser(userId);
  if (user?.blocked) {
    ctx.log.debug(`Blocked user ${message.author.tag} tried to send message`);
    return;
  }

  // Get mapping for this channel
  const mapping = config.mappings?.[message.channel.id];

  // In DMs, always respond if user is authorized
  // In channels, require mention or respondToAll config
  if (!isDM && !isMentioned) {
    if (!mapping?.respondToAll) return;
  }

  // Get session for this channel
  const session = getSessionForChannel(message.channel);
  if (!session) {
    ctx.log.debug(`No mapping for channel ${message.channel.id}, ignoring`);
    return;
  }

  // Check if user is authorized for this session
  if (!isUserAuthorized(userId, session)) {
    // Check channel-level permissions
    if (mapping?.allowedUsers && mapping.allowedUsers !== "*") {
      if (!mapping.allowedUsers.includes(userId)) {
        ctx.log.debug(`User ${message.author.tag} not authorized for ${session}`);
        return;
      }
    } else if (config.defaultAccess === "none") {
      ctx.log.debug(`User ${message.author.tag} not paired, defaultAccess=none`);
      return;
    } else if (config.defaultAccess === "paired") {
      // User not paired - generate pairing request
      const channelName = message.channel.name || "DM";
      const guildName = message.guild?.name || "Direct Message";
      const result = createPairingRequest(userId, message.author.username, channelName, guildName, session);

      if (result.existing) {
        await message.reply(
          `You have a pending pairing request. Your code is: **${result.code}**\n` +
          `Ask the owner to run: \`wopr discord pair approve ${result.code}\``
        );
      } else {
        await message.reply(
          `Hi ${message.author.username}! I don't recognize you yet.\n\n` +
          `Your pairing code is: **${result.code}**\n\n` +
          `Ask the owner to run: \`wopr discord pair approve ${result.code}\``
        );
        ctx.log.info(`Pairing request from ${message.author.tag}: ${result.code} (session: ${session})`);
      }
      return;
    }
  }

  // Clean up the message
  let content = message.content;
  if (isMentioned) {
    content = content.replace(/<@!?\d+>/g, "").trim();
  }

  if (!content) return;

  // Show typing
  await message.channel.sendTyping();

  const prompt = `[${message.author.username}]: ${content}`;
  ctx.log.info(`${message.author.tag} -> ${session}: ${content.substring(0, 50)}...`);

  try {
    // Track this request so we don't double-post via injection event
    const requestId = `${session}:${Date.now()}`;
    pendingDiscordRequests.add(requestId);

    // Buffer for accumulating text between sends
    let textBuffer = "";
    let lastSendTime = 0;
    const minSendInterval = 1500; // Don't flood Discord - wait at least 1.5s between messages
    let repliedOnce = false;
    let typingInterval = null;

    // Keep typing indicator active during long operations
    typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 5000);

    // Flush buffer to Discord
    const flushBuffer = async (force = false) => {
      const now = Date.now();
      if (!textBuffer.trim()) return;

      // Rate limit sends unless forced (complete/error)
      if (!force && now - lastSendTime < minSendInterval) return;

      // Chunk for Discord's 2000 char limit
      const chunks = textBuffer.match(/[\s\S]{1,1990}/g) || [];
      for (const chunk of chunks) {
        if (!repliedOnce) {
          await message.reply(chunk);
          repliedOnce = true;
        } else {
          await message.channel.send(chunk);
        }
      }
      textBuffer = "";
      lastSendTime = now;
    };

    // Stream handler - send messages as they arrive
    const onStream = async (msg) => {
      switch (msg.type) {
        case "text":
          textBuffer += msg.content;
          // Flush if buffer gets large enough
          if (textBuffer.length > 500) {
            await flushBuffer();
          }
          break;

        case "tool_use":
          // Send a brief notification about tool use
          if (msg.toolName) {
            await message.channel.sendTyping();
            ctx.log.debug(`Tool: ${msg.toolName}`);
          }
          break;

        case "complete":
          // Final flush
          await flushBuffer(true);
          break;

        case "error":
          await flushBuffer(true);
          if (!repliedOnce) {
            await message.reply(`Error: ${msg.content}`);
          }
          break;
      }
    };

    await ctx.inject(session, prompt, onStream);

    // Final flush in case anything remains
    await flushBuffer(true);

    // Cleanup
    if (typingInterval) clearInterval(typingInterval);

    // Remove from pending (with small delay for event propagation)
    setTimeout(() => pendingDiscordRequests.delete(requestId), 1000);

    // Update last seen
    if (config.users?.[userId]) {
      config.users[userId].lastSeen = Date.now();
      ctx.saveConfig(config);
    }
  } catch (err) {
    ctx.log.error(`Injection error: ${err.message}`);
    await message.reply("Sorry, I encountered an error processing that request.");
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const plugin = {
  name: "discord",
  version: "1.0.0",
  description: "Discord bot with user pairing and access control",

  commands: [
    {
      name: "auth",
      description: "Set up Discord bot token",
      usage: "wopr discord auth",
      async handler(context, args) {
        ctx = context;

        console.log(`
Discord Bot Setup
=================

1. Go to https://discord.com/developers/applications
2. Click "New Application" and give it a name
3. Go to "Bot" section, click "Add Bot"
4. Under "Privileged Gateway Intents", enable MESSAGE CONTENT INTENT
5. Click "Reset Token" to get a new token
6. Copy the token

`);

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const token = await new Promise((resolve) => {
          rl.question("Paste your bot token: ", (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });

        if (!token) {
          console.error("No token provided.");
          process.exit(1);
        }

        const config = context.getConfig();
        config.token = token;
        config.mappings = config.mappings || {};
        config.users = config.users || {};
        config.pairingCodes = config.pairingCodes || {};
        config.autoCreate = true;
        config.defaultAccess = "all"; // all, paired, none
        await context.saveConfig(config);

        console.log("\nToken saved!");
        console.log("Default access: all (anyone can use the bot)");
        console.log("\nTo restrict access, run: wopr discord access paired");
        console.log("Then create pairing codes: wopr discord pair create <sessions>");
      },
    },
    {
      name: "status",
      description: "Show Discord connection status",
      usage: "wopr discord status",
      async handler(context, args) {
        const config = context.getConfig();

        if (!config.token) {
          console.log("Not configured. Run: wopr discord auth");
          return;
        }

        console.log("Discord Plugin Status");
        console.log("=====================");
        console.log(`Token: ${config.token.substring(0, 10)}...`);
        console.log(`Auto-create: ${config.autoCreate ? "enabled" : "disabled"}`);
        console.log(`Default access: ${config.defaultAccess || "all"}`);
        console.log(`Mapped channels: ${Object.keys(config.mappings || {}).length}`);
        console.log(`Paired users: ${Object.keys(config.users || {}).length}`);
        console.log(`Active pairing codes: ${Object.keys(config.pairingCodes || {}).length}`);

        if (client && client.isReady()) {
          console.log(`\nConnected as: ${client.user.tag}`);
          console.log(`Servers: ${client.guilds.cache.size}`);
        } else {
          console.log("\nNot connected (daemon not running?)");
        }
      },
    },
    {
      name: "access",
      description: "Set default access policy",
      usage: "wopr discord access [all|paired|none]",
      async handler(context, args) {
        const config = context.getConfig();

        if (!args[0]) {
          console.log(`Current default access: ${config.defaultAccess || "all"}`);
          console.log("\nOptions:");
          console.log("  all    - Anyone can use the bot");
          console.log("  paired - Only paired users can use the bot");
          console.log("  none   - Only explicitly granted users");
          return;
        }

        const policy = args[0].toLowerCase();
        if (!["all", "paired", "none"].includes(policy)) {
          console.error("Invalid policy. Use: all, paired, or none");
          process.exit(1);
        }

        config.defaultAccess = policy;
        await context.saveConfig(config);
        console.log(`Default access set to: ${policy}`);
      },
    },
    {
      name: "pair",
      description: "Manage pairing requests",
      usage: "wopr discord pair <list|approve|reject> [options]",
      async handler(context, args) {
        ctx = context;
        const config = context.getConfig();
        const action = args[0];

        if (!action || action === "list") {
          const requests = config.pairingRequests || {};
          const pending = Object.entries(requests).filter(([_, r]) => r.status === "pending");

          if (pending.length === 0) {
            console.log("No pending pairing requests.");
            return;
          }

          console.log("Pending Pairing Requests:");
          for (const [code, req] of pending) {
            const when = new Date(req.createdAt).toLocaleString();
            console.log(`  ${code} - ${req.userName}`);
            console.log(`    Session: ${req.session}`);
            console.log(`    From: #${req.channelName} in ${req.guildName}`);
            console.log(`    When: ${when}`);
          }
          console.log("\nTo approve: wopr discord pair approve <code>");
          console.log("To reject:  wopr discord pair reject <code> [reason]");
          return;
        }

        if (action === "approve") {
          const code = args[1]?.toUpperCase();
          const sessions = args[2] ? args[2].split(",") : null; // null = use default from request

          if (!code) {
            console.error("Usage: wopr discord pair approve <code> [sessions]");
            console.error("If sessions omitted, grants access to the session they tried to use.");
            process.exit(1);
          }

          const result = approvePairingRequest(code, sessions);

          if (result.error) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
          }

          console.log(`Approved ${result.user.userName} (${result.user.userId})`);
          console.log(`Sessions: ${result.sessions.join(", ")}`);
          return;
        }

        if (action === "reject") {
          const code = args[1]?.toUpperCase();
          const reason = args.slice(2).join(" ") || undefined;

          if (!code) {
            console.error("Usage: wopr discord pair reject <code> [reason]");
            process.exit(1);
          }

          const result = rejectPairingRequest(code, reason);

          if (result.error) {
            console.error(`Error: ${result.error}`);
            process.exit(1);
          }

          console.log(`Rejected pairing request: ${code}`);
          return;
        }

        if (action === "history") {
          const requests = config.pairingRequests || {};
          const all = Object.entries(requests);

          if (all.length === 0) {
            console.log("No pairing requests.");
            return;
          }

          console.log("All Pairing Requests:");
          for (const [code, req] of all) {
            const status = req.status.toUpperCase();
            const when = new Date(req.createdAt).toLocaleString();
            console.log(`  ${code} - ${req.userName} [${status}]`);
            console.log(`    When: ${when}`);
            if (req.sessions) console.log(`    Sessions: ${req.sessions.join(", ")}`);
            if (req.rejectReason) console.log(`    Reason: ${req.rejectReason}`);
          }
          return;
        }

        console.error("Usage: wopr discord pair <list|approve|reject|history>");
      },
    },
    {
      name: "users",
      description: "List paired users",
      usage: "wopr discord users",
      async handler(context, args) {
        const config = context.getConfig();
        const users = config.users || {};

        if (Object.keys(users).length === 0) {
          console.log("No paired users.");
          return;
        }

        console.log("Paired Users:");
        for (const [id, user] of Object.entries(users)) {
          const status = user.blocked ? " [BLOCKED]" : "";
          const sessions = user.sessions?.join(", ") || "none";
          console.log(`  ${id} - ${user.name || "unknown"}${status}`);
          console.log(`    Sessions: ${sessions}`);
          if (user.pairedAt) console.log(`    Paired: ${new Date(user.pairedAt).toLocaleString()}`);
          if (user.lastSeen) console.log(`    Last seen: ${new Date(user.lastSeen).toLocaleString()}`);
        }
      },
    },
    {
      name: "grant",
      description: "Grant user access to sessions",
      usage: "wopr discord grant <user-id> <sessions> [--name name]",
      async handler(context, args) {
        ctx = context;

        if (!args[0] || !args[1]) {
          console.error("Usage: wopr discord grant <user-id> <sessions> [--name name]");
          process.exit(1);
        }

        const userId = args[0];
        const sessions = args[1].split(",");
        const nameIdx = args.indexOf("--name");
        const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

        grantUserAccess(userId, sessions, name);
        console.log(`Granted ${userId} access to: ${sessions.join(", ")}`);
      },
    },
    {
      name: "revoke",
      description: "Revoke user access",
      usage: "wopr discord revoke <user-id> [sessions]",
      async handler(context, args) {
        ctx = context;

        if (!args[0]) {
          console.error("Usage: wopr discord revoke <user-id> [sessions]");
          process.exit(1);
        }

        const userId = args[0];
        const sessions = args[1] ? args[1].split(",") : ["*"];

        revokeUserAccess(userId, sessions);
        console.log(`Revoked ${userId}'s access to: ${sessions.join(", ")}`);
      },
    },
    {
      name: "block",
      description: "Block a user",
      usage: "wopr discord block <user-id> [reason]",
      async handler(context, args) {
        ctx = context;

        if (!args[0]) {
          console.error("Usage: wopr discord block <user-id> [reason]");
          process.exit(1);
        }

        const userId = args[0];
        const reason = args.slice(1).join(" ") || undefined;

        blockUser(userId, reason);
        console.log(`Blocked user: ${userId}`);
      },
    },
    {
      name: "unblock",
      description: "Unblock a user",
      usage: "wopr discord unblock <user-id>",
      async handler(context, args) {
        ctx = context;

        if (!args[0]) {
          console.error("Usage: wopr discord unblock <user-id>");
          process.exit(1);
        }

        unblockUser(args[0]);
        console.log(`Unblocked user: ${args[0]}`);
      },
    },
    {
      name: "map",
      description: "Map a Discord channel to a WOPR session",
      usage: "wopr discord map <channel-id> <session> [--all] [--users user1,user2]",
      async handler(context, args) {
        if (!args[0] || !args[1]) {
          console.error("Usage: wopr discord map <channel-id> <session> [--all] [--users user1,user2]");
          process.exit(1);
        }

        const channelId = args[0];
        const session = args[1];
        const respondToAll = args.includes("--all");
        const usersIdx = args.indexOf("--users");
        const allowedUsers = usersIdx >= 0 ? args[usersIdx + 1].split(",") : "*";

        const config = context.getConfig();
        config.mappings = config.mappings || {};
        config.mappings[channelId] = {
          session,
          respondToAll,
          allowedUsers,
          createdAt: Date.now(),
        };
        await context.saveConfig(config);

        console.log(`Mapped channel ${channelId} -> session "${session}"`);
      },
    },
    {
      name: "unmap",
      description: "Remove a channel mapping",
      usage: "wopr discord unmap <channel-id>",
      async handler(context, args) {
        if (!args[0]) {
          console.error("Usage: wopr discord unmap <channel-id>");
          process.exit(1);
        }

        const channelId = args[0];
        const config = context.getConfig();

        if (!config.mappings?.[channelId]) {
          console.error(`No mapping for channel ${channelId}`);
          process.exit(1);
        }

        delete config.mappings[channelId];
        await context.saveConfig(config);
        console.log(`Unmapped channel ${channelId}`);
      },
    },
    {
      name: "mappings",
      description: "List all channel -> session mappings",
      usage: "wopr discord mappings",
      async handler(context, args) {
        const config = context.getConfig();
        const mappings = config.mappings || {};

        if (Object.keys(mappings).length === 0) {
          console.log("No channel mappings.");
          return;
        }

        console.log("Channel -> Session Mappings:");
        for (const [channelId, mapping] of Object.entries(mappings)) {
          console.log(`  ${channelId} -> "${mapping.session}"`);
          if (mapping.channelName) console.log(`    Channel: #${mapping.channelName}`);
          if (mapping.guildName) console.log(`    Server: ${mapping.guildName}`);
          if (mapping.respondToAll) console.log(`    Mode: respond to all`);
        }
      },
    },
    {
      name: "auto",
      description: "Enable/disable auto-create mode",
      usage: "wopr discord auto [on|off]",
      async handler(context, args) {
        const config = context.getConfig();

        if (!args[0]) {
          console.log(`Auto-create: ${config.autoCreate ? "ON" : "OFF"}`);
          return;
        }

        const value = args[0].toLowerCase();
        config.autoCreate = value === "on" || value === "true" || value === "1";
        await context.saveConfig(config);
        console.log(`Auto-create ${config.autoCreate ? "enabled" : "disabled"}`);
      },
    },
  ],

  async init(context) {
    ctx = context;
    const config = context.getConfig();

    if (!config.token) {
      context.log.warn("Discord not configured. Run: wopr discord auth");
      return;
    }

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.once(Events.ClientReady, (c) => {
      context.log.info(`Discord connected as ${c.user.tag}`);
    });

    client.on(Events.MessageCreate, handleMessage);

    client.on(Events.Error, (err) => {
      context.log.error(`Discord error: ${err.message}`);
    });

    // Subscribe to ALL session injections - mirror to Discord if mapped
    context.on("injection", async (session, from, message, response) => {
      // Skip if we have a pending Discord request for this session (avoid double-post)
      const hasPending = [...pendingDiscordRequests].some(id => id.startsWith(`${session}:`));
      if (hasPending) return;

      // Find channel mapped to this session
      const mapping = Object.entries(config.mappings || {}).find(
        ([_, m]) => m.session === session
      );

      if (!mapping) return;

      const [channelId] = mapping;

      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && response) {
          // Chunk for Discord's 2000 char limit
          const chunks = response.match(/[\s\S]{1,1990}/g) || [];
          for (const chunk of chunks) {
            await channel.send(`**[${session}]** ${chunk}`);
          }
          context.log.info(`Mirrored ${session} response to Discord`);
        }
      } catch (err) {
        context.log.error(`Failed to mirror to Discord: ${err.message}`);
      }
    });

    try {
      await client.login(config.token);
    } catch (err) {
      context.log.error(`Discord login failed: ${err.message}`);
    }
  },

  async shutdown() {
    if (client) {
      ctx?.log.info("Discord disconnecting...");
      await client.destroy();
      client = null;
    }
  },
};

export default plugin;
