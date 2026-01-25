#!/usr/bin/env node

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";

// Import from modules
import {
  WOPR_HOME, SESSIONS_DIR, SKILLS_DIR, SESSIONS_FILE,
  REGISTRIES_FILE, CRONS_FILE, PID_FILE, LOG_FILE
} from "./paths.js";
import type { CronJob, Registry, SkillPointer, StreamCallback } from "./types.js";
import { EXIT_OK, EXIT_OFFLINE, EXIT_REJECTED, EXIT_INVALID, EXIT_RATE_LIMITED, EXIT_VERSION_MISMATCH, PROTOCOL_VERSION } from "./types.js";
import {
  getIdentity, initIdentity as initId, shortKey, createInviteToken, rotateIdentity
} from "./identity.js";
import {
  getAccessGrants, getPeers, savePeers, findPeer, revokePeer, namePeer, cleanupExpiredKeyHistory
} from "./trust.js";
import { sendP2PInject, claimToken, createP2PListener, sendKeyRotation } from "./p2p.js";
import {
  initDiscovery, joinTopic, leaveTopic, getTopics, getTopicPeers,
  getAllPeers, updateProfile, getProfile, requestConnection, shutdownDiscovery
} from "./discovery.js";
import {
  installPlugin, removePlugin, enablePlugin, disablePlugin, listPlugins,
  loadAllPlugins, getLoadedPlugin, getPluginCommands,
  addRegistry as addPluginRegistry, removeRegistry as removePluginRegistry, listRegistries as listPluginRegistries,
  searchPlugins
} from "./plugins.js";

// Ensure directories exist
[WOPR_HOME, SESSIONS_DIR, SKILLS_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// ==================== Registry Functions ====================

function getRegistries(): Registry[] {
  if (!existsSync(REGISTRIES_FILE)) return [];
  return JSON.parse(readFileSync(REGISTRIES_FILE, "utf-8"));
}

function saveRegistries(registries: Registry[]): void {
  writeFileSync(REGISTRIES_FILE, JSON.stringify(registries, null, 2));
}

async function fetchRegistryIndex(url: string, searchQuery?: string): Promise<SkillPointer[]> {
  if (url.startsWith("github:")) {
    const parts = url.replace("github:", "").split("/");
    const owner = parts[0];
    const repo = parts[1];
    const path = parts.slice(2).join("/") || "skills";
    return await fetchGitHubSkills(owner, repo, path, searchQuery);
  }

  if (url.includes("github.com") && !url.includes("/raw/")) {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/[^\/]+\/(.+))?/);
    if (match) {
      const [, owner, repo, path] = match;
      return await fetchGitHubSkills(owner, repo, path || "skills", searchQuery);
    }
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.items && Array.isArray(data.items)) {
      return data.items.map((item: any) => ({
        name: item.slug || item.name,
        description: item.summary || item.description || item.displayName || "",
        source: item.source || item.repository || item.url,
        version: item.latestVersion?.version || item.version,
      }));
    }

    if (Array.isArray(data)) return data as SkillPointer[];
    if (data.skills && Array.isArray(data.skills)) return data.skills as SkillPointer[];
    return [];
  } catch {
    return [];
  }
}

async function fetchGitHubSkills(owner: string, repo: string, path: string, searchQuery?: string): Promise<SkillPointer[]> {
  const token = process.env.GITHUB_TOKEN;

  if (token) {
    const skills: SkillPointer[] = [];
    const q = searchQuery
      ? `${searchQuery}+filename:SKILL.md+repo:${owner}/${repo}+path:${path}`
      : `filename:SKILL.md+repo:${owner}/${repo}+path:${path}`;

    try {
      for (let page = 1; page <= 6; page++) {
        const res = await fetch(
          `https://api.github.com/search/code?q=${q}&per_page=100&page=${page}`,
          { headers: { Authorization: `token ${token}` } }
        );
        if (!res.ok) break;
        const data = await res.json();
        if (!data.items?.length) break;

        for (const item of data.items) {
          const parts = item.path.replace(/\/SKILL\.md$/i, "").split("/");
          skills.push({
            name: parts[parts.length - 1],
            description: "",
            source: `github:${owner}/${repo}/${parts.join("/")}`,
          });
        }
        if (data.items.length < 100) break;
      }
    } catch { /* fall through to clone */ }

    if (skills.length > 0) return skills;
  }

  const cacheDir = join(WOPR_HOME, ".cache", `${owner}-${repo}`);

  if (!existsSync(cacheDir)) {
    console.log(`Caching ${owner}/${repo}...`);
    mkdirSync(join(WOPR_HOME, ".cache"), { recursive: true });
    try {
      execSync(`git clone --depth 1 https://github.com/${owner}/${repo}.git "${cacheDir}"`, { stdio: "pipe" });
    } catch {
      console.error(`Failed to clone ${owner}/${repo}`);
      return [];
    }
  } else {
    try {
      execSync(`git -C "${cacheDir}" pull --depth 1`, { stdio: "pipe" });
    } catch { /* ignore */ }
  }

  const skills: SkillPointer[] = [];
  const skillsPath = join(cacheDir, path);
  if (!existsSync(skillsPath)) return [];

  const q = searchQuery?.toLowerCase();

  function scanDir(dir: string, depth: number): void {
    if (depth > 2) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subdir = join(dir, entry.name);
      const skillMd = join(subdir, "SKILL.md");

      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const meta = parseSkillFrontmatter(content);
        if (!q || entry.name.toLowerCase().includes(q) || content.toLowerCase().includes(q)) {
          skills.push({
            name: entry.name,
            description: meta.description || "",
            source: `github:${owner}/${repo}/${subdir.replace(cacheDir + "/", "")}`,
          });
        }
      } else {
        scanDir(subdir, depth + 1);
      }
    }
  }

  scanDir(skillsPath, 0);
  return skills;
}

// ==================== Skills ====================

interface Skill {
  name: string;
  description: string;
  path: string;
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

function discoverSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];

  const skills: Skill[] = [];
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());

  for (const dir of dirs) {
    const skillPath = join(SKILLS_DIR, dir.name, "SKILL.md");
    if (existsSync(skillPath)) {
      const content = readFileSync(skillPath, "utf-8");
      const { name, description } = parseSkillFrontmatter(content);
      skills.push({
        name: name || dir.name,
        description: description || `Skill: ${dir.name}`,
        path: skillPath,
      });
    }
  }
  return skills;
}

function formatSkillsXml(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const skillsXml = skills.map(s =>
    `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
    <location>${s.path}</location>
  </skill>`
  ).join("\n");

  return `
<available_skills>
${skillsXml}
</available_skills>

When you need to use a skill, read its full SKILL.md file at the location shown above.
`;
}

// ==================== Sessions ====================

function getSessions(): Record<string, string> {
  return existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, "utf-8")) : {};
}

function saveSessionId(name: string, id: string): void {
  const sessions = getSessions();
  sessions[name] = id;
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function deleteSessionId(name: string): void {
  const sessions = getSessions();
  delete sessions[name];
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function getSessionContext(name: string): string | undefined {
  const contextFile = join(SESSIONS_DIR, `${name}.md`);
  return existsSync(contextFile) ? readFileSync(contextFile, "utf-8") : undefined;
}

async function inject(
  name: string,
  message: string,
  options?: { silent?: boolean; onStream?: StreamCallback }
): Promise<string> {
  const sessions = getSessions();
  const existingSessionId = sessions[name];
  const context = getSessionContext(name);
  const silent = options?.silent ?? false;
  const onStream = options?.onStream;
  const collected: string[] = [];

  if (!silent) {
    console.log(`[wopr] Injecting into session: ${name}`);
    if (existingSessionId) {
      console.log(`[wopr] Resuming session: ${existingSessionId}`);
    } else {
      console.log(`[wopr] Creating new session`);
    }
  }

  const skills = discoverSkills();
  const skillsXml = formatSkillsXml(skills);
  const baseContext = context || `You are WOPR session "${name}".`;
  const fullContext = skillsXml ? `${baseContext}\n${skillsXml}` : baseContext;

  const q = query({
    prompt: message,
    options: {
      resume: existingSessionId,
      systemPrompt: fullContext,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    }
  });

  for await (const msg of q) {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          saveSessionId(name, msg.session_id);
          if (!silent) console.log(`[wopr] Session ID: ${msg.session_id}`);
        }
        break;
      case "assistant":
        for (const block of msg.message.content) {
          if (block.type === "text") {
            collected.push(block.text);
            if (!silent) console.log(block.text);
            if (onStream) onStream({ type: "text", content: block.text });
          } else if (block.type === "tool_use") {
            if (!silent) console.log(`[tool] ${block.name}`);
            if (onStream) onStream({ type: "tool_use", content: "", toolName: block.name });
          }
        }
        break;
      case "result":
        if (msg.subtype === "success") {
          if (!silent) console.log(`\n[wopr] Complete. Cost: $${msg.total_cost_usd.toFixed(4)}`);
          if (onStream) onStream({ type: "complete", content: `Cost: $${msg.total_cost_usd.toFixed(4)}` });
        } else {
          if (!silent) console.error(`[wopr] Error: ${msg.subtype}`);
          if (onStream) onStream({ type: "error", content: msg.subtype });
        }
        break;
    }
  }

  return collected.join("\n");
}

// ==================== Cron ====================

function getCrons(): CronJob[] {
  return existsSync(CRONS_FILE) ? JSON.parse(readFileSync(CRONS_FILE, "utf-8")) : [];
}

function saveCrons(crons: CronJob[]): void {
  writeFileSync(CRONS_FILE, JSON.stringify(crons, null, 2));
}

function parseCron(schedule: string): { minute: number[]; hour: number[]; day: number[]; month: number[]; weekday: number[] } {
  const parts = schedule.split(" ");
  if (parts.length !== 5) throw new Error("Invalid cron schedule");

  const parse = (part: string, max: number): number[] => {
    if (part === "*") return Array.from({ length: max }, (_, i) => i);
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2));
      return Array.from({ length: max }, (_, i) => i).filter(i => i % step === 0);
    }
    if (part.includes(",")) return part.split(",").map(Number);
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    }
    return [parseInt(part)];
  };

  return {
    minute: parse(parts[0], 60),
    hour: parse(parts[1], 24),
    day: parse(parts[2], 32),
    month: parse(parts[3], 13),
    weekday: parse(parts[4], 7),
  };
}

function shouldRun(schedule: string, date: Date): boolean {
  try {
    const cron = parseCron(schedule);
    return (
      cron.minute.includes(date.getMinutes()) &&
      cron.hour.includes(date.getHours()) &&
      cron.day.includes(date.getDate()) &&
      cron.month.includes(date.getMonth() + 1) &&
      cron.weekday.includes(date.getDay())
    );
  } catch {
    return false;
  }
}

function parseTimeSpec(spec: string): number {
  const now = Date.now();
  if (spec === "now") return now;

  if (spec.startsWith("+")) {
    const match = spec.match(/^\+(\d+)([smhd])$/);
    if (match) {
      const val = parseInt(match[1]);
      const unit = match[2];
      const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]!;
      return now + val * mult;
    }
  }

  if (/^\d{10,13}$/.test(spec)) {
    const ts = parseInt(spec);
    return ts < 1e12 ? ts * 1000 : ts;
  }

  if (/^\d{1,2}:\d{2}$/.test(spec)) {
    const [h, m] = spec.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() < now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const parsed = Date.parse(spec);
  if (!isNaN(parsed)) return parsed;

  throw new Error(`Invalid time spec: ${spec}`);
}

// ==================== Daemon ====================

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

function daemonLog(msg: string): void {
  const timestamp = new Date().toISOString();
  writeFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`, { flag: "a" });
}

async function runDaemon(): Promise<void> {
  writeFileSync(PID_FILE, process.pid.toString());
  daemonLog(`Daemon started (PID ${process.pid})`);

  const lastRun: Record<string, number> = {};

  const tick = async () => {
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
        if (currentMinute > lastMinute && shouldRun(cron.schedule, now)) shouldExecute = true;
      }

      if (shouldExecute) {
        lastRun[key] = Math.floor(nowTs / 60000);
        daemonLog(`Running: ${cron.name} -> ${cron.session}`);
        try {
          await inject(cron.session, cron.message);
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

  setInterval(tick, 30000);
  tick();

  // P2P listener using module
  const swarm = createP2PListener(
    async (session, message) => {
      await inject(session, message);
    },
    daemonLog
  );

  // Discovery mode - join topics from env var WOPR_TOPICS (comma-separated)
  const topicsEnv = process.env.WOPR_TOPICS;
  if (topicsEnv) {
    const topics = topicsEnv.split(",").map(t => t.trim()).filter(t => t);
    if (topics.length > 0) {
      daemonLog(`Discovery: joining ${topics.length} topic(s)`);

      // AI-driven connection handler - asks the "discovery" session to decide
      const connectionHandler = async (peerProfile: any, topic: string) => {
        daemonLog(`Connection request from ${peerProfile.id} in ${topic}`);

        // Inject to discovery session to let AI decide
        const prompt = `A peer wants to connect:
ID: ${peerProfile.id}
Topic: ${topic}
Profile: ${JSON.stringify(peerProfile.content)}

Should I accept this connection? If yes, which sessions should I grant access to?
Reply with JSON: {"accept": true/false, "sessions": ["session1"], "reason": "why"}`;

        try {
          // For now, we'll auto-accept connections in the same topic
          // In a full implementation, this would query the AI
          daemonLog(`Auto-accepting connection from ${peerProfile.id}`);
          return {
            accept: true,
            sessions: ["*"],  // Grant all sessions - AI can restrict via context
            reason: `Discovered in ${topic}`,
          };
        } catch (err) {
          daemonLog(`Connection handler error: ${err}`);
          return { accept: false, reason: "Error processing request" };
        }
      };

      await initDiscovery(connectionHandler, daemonLog);

      // Set a default profile
      const identity = getIdentity();
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

  process.on("SIGTERM", async () => {
    daemonLog("Daemon stopping...");
    await shutdownDiscovery();
    if (swarm) await swarm.destroy();
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    daemonLog("Daemon stopped");
    process.exit(0);
  });
}

// ==================== CLI Commands ====================

function help(): void {
  console.log(`
wopr - Self-sovereign AI session management

Usage:
  wopr session create <name> [context]   Create a session with optional context
  wopr session inject <name> <message>   Inject a message into a session
  wopr session list                      List all sessions
  wopr session show <name>               Show session details
  wopr session delete <name>             Delete a session

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

  wopr daemon start                          Start scheduler daemon
  wopr daemon stop                           Stop daemon
  wopr daemon status                         Check if daemon is running
  wopr daemon logs                           Show daemon logs

  wopr id                                    Show your WOPR ID
  wopr id init [--force]                     Generate identity keypair
  wopr id rotate [--broadcast]               Rotate keys (notifies peers if --broadcast)

  wopr invite <peer-pubkey> <session>        Create invite for specific peer
  wopr invite claim <token>                  Claim an invite (P2P handshake)

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
  wopr plugin config <name>                  Edit plugin config ($EDITOR)
  wopr plugin search <query>                 Search npm for plugins

  wopr plugin registry list                  List plugin registries
  wopr plugin registry add <name> <url>      Add a plugin registry
  wopr plugin registry remove <name>         Remove a plugin registry

  wopr <plugin> <command> [args...]          Run a plugin command
                                             Example: wopr discord auth

Environment:
  WOPR_HOME                              Base directory (default: ~/wopr)
  ANTHROPIC_API_KEY                      API key for Claude

P2P messages are end-to-end encrypted using X25519 ECDH + AES-256-GCM.
Tokens are bound to the recipient's public key - they cannot be forwarded.
Discovery is ephemeral - you see peers only while both are online in the same topic.
`);
}

// ==================== Main ====================

const [,, command, subcommand, ...args] = process.argv;

(async () => {
  if (command === "session") {
    switch (subcommand) {
      case "create": {
        if (!args[0]) {
          console.error("Usage: wopr session create <name> [context]");
          process.exit(1);
        }
        const contextPath = join(SESSIONS_DIR, `${args[0]}.md`);
        const content = args.slice(1).join(" ") || `You are WOPR session "${args[0]}".`;
        writeFileSync(contextPath, content);
        console.log(`Created session "${args[0]}"`);
        break;
      }
      case "inject":
        if (!args[0] || !args[1]) {
          console.error("Usage: wopr session inject <name> <message>");
          process.exit(1);
        }
        await inject(args[0], args.slice(1).join(" "));
        break;
      case "list": {
        const sessions = getSessions();
        const names = Object.keys(sessions);
        if (names.length === 0) {
          console.log("No sessions.");
        } else {
          console.log("Sessions:");
          for (const name of names) {
            const hasContext = existsSync(join(SESSIONS_DIR, `${name}.md`));
            console.log(`  ${name}${hasContext ? " (has context)" : ""}`);
          }
        }
        break;
      }
      case "show": {
        if (!args[0]) {
          console.error("Usage: wopr session show <name>");
          process.exit(1);
        }
        const sessions = getSessions();
        const context = getSessionContext(args[0]);
        console.log(`Session: ${args[0]}`);
        console.log(`ID: ${sessions[args[0]] || "(not started)"}`);
        if (context) console.log(`\n--- Context ---\n${context}\n--- End ---`);
        break;
      }
      case "delete": {
        if (!args[0]) {
          console.error("Usage: wopr session delete <name>");
          process.exit(1);
        }
        deleteSessionId(args[0]);
        const contextPath = join(SESSIONS_DIR, `${args[0]}.md`);
        if (existsSync(contextPath)) unlinkSync(contextPath);
        console.log(`Deleted session "${args[0]}"`);
        break;
      }
      default:
        help();
    }
  } else if (command === "skill") {
    if (subcommand === "registry") {
      const registryCmd = args[0];
      switch (registryCmd) {
        case "list": {
          const registries = getRegistries();
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
          const regs = getRegistries();
          regs.push({ name: args[1], url: args[2] });
          saveRegistries(regs);
          console.log(`Added registry: ${args[1]}`);
          break;
        case "remove": {
          if (!args[1]) {
            console.error("Usage: wopr skill registry remove <name>");
            process.exit(1);
          }
          let registries = getRegistries();
          registries = registries.filter(r => r.name !== args[1]);
          saveRegistries(registries);
          console.log(`Removed registry: ${args[1]}`);
          break;
        }
        default:
          help();
      }
    } else {
      switch (subcommand) {
        case "list": {
          const skills = discoverSkills();
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
          const registries = getRegistries();
          const results: { registry: string; skill: SkillPointer }[] = [];
          for (const reg of registries) {
            const skills = await fetchRegistryIndex(reg.url, args.join(" "));
            for (const skill of skills) results.push({ registry: reg.name, skill });
          }
          if (results.length === 0) {
            console.log(`No skills found matching "${args.join(" ")}"`);
          } else {
            console.log(`Found ${results.length} skill(s):`);
            for (const { registry, skill } of results) {
              console.log(`  ${skill.name} (${registry})`);
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
          // Simplified install - just clone
          let source = args[0];
          if (source.startsWith("github:")) {
            const parts = source.replace("github:", "").split("/");
            const [owner, repo, ...pathParts] = parts;
            const skillPath = pathParts.join("/");
            const skillName = args[1] || pathParts[pathParts.length - 1];
            const targetDir = join(SKILLS_DIR, skillName);
            if (existsSync(targetDir)) {
              console.error(`Skill "${skillName}" already exists`);
              process.exit(1);
            }
            console.log(`Installing ${skillName}...`);
            const tmpDir = join(SKILLS_DIR, `.tmp-${Date.now()}`);
            try {
              execSync(`git clone --depth 1 --filter=blob:none --sparse https://github.com/${owner}/${repo}.git "${tmpDir}"`, { stdio: "pipe" });
              execSync(`git -C "${tmpDir}" sparse-checkout set "${skillPath}"`, { stdio: "pipe" });
              execSync(`mv "${tmpDir}/${skillPath}" "${targetDir}"`, { stdio: "pipe" });
              execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" });
              console.log(`Installed: ${skillName}`);
            } catch {
              execSync(`rm -rf "${tmpDir}"`, { stdio: "ignore" });
              console.error(`Failed to install`);
              process.exit(1);
            }
          } else {
            const skillName = args[1] || basename(source).replace(/\.git$/, "");
            const targetDir = join(SKILLS_DIR, skillName);
            if (existsSync(targetDir)) {
              console.error(`Skill "${skillName}" already exists`);
              process.exit(1);
            }
            execSync(`git clone "${source}" "${targetDir}"`, { stdio: "inherit" });
            console.log(`Installed: ${skillName}`);
          }
          break;
        }
        case "create": {
          if (!args[0]) {
            console.error("Usage: wopr skill create <name> [description]");
            process.exit(1);
          }
          const targetDir = join(SKILLS_DIR, args[0]);
          if (existsSync(targetDir)) {
            console.error(`Skill "${args[0]}" already exists`);
            process.exit(1);
          }
          mkdirSync(targetDir, { recursive: true });
          const desc = args.slice(1).join(" ") || `WOPR skill: ${args[0]}`;
          writeFileSync(join(targetDir, "SKILL.md"), `---\nname: ${args[0]}\ndescription: ${desc}\n---\n\n# ${args[0]}\n`);
          console.log(`Created: ${targetDir}/SKILL.md`);
          break;
        }
        case "remove": {
          if (!args[0]) {
            console.error("Usage: wopr skill remove <name>");
            process.exit(1);
          }
          const targetDir = join(SKILLS_DIR, args[0]);
          if (!existsSync(targetDir)) {
            console.error(`Skill "${args[0]}" not found`);
            process.exit(1);
          }
          execSync(`rm -rf "${targetDir}"`);
          console.log(`Removed: ${args[0]}`);
          break;
        }
        case "cache":
          if (args[0] === "clear") {
            const cacheDir = join(WOPR_HOME, ".cache");
            if (existsSync(cacheDir)) {
              execSync(`rm -rf "${cacheDir}"`);
              console.log("Cache cleared");
            }
          }
          break;
        default:
          help();
      }
    }
  } else if (command === "cron") {
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
        const crons = getCrons();
        const job: CronJob = {
          name: filtered[0],
          schedule: filtered[1],
          session: filtered[2],
          message: filtered.slice(3).join(" "),
          once: flags.once || undefined,
        };
        crons.push(job);
        saveCrons(crons);
        console.log(`Added cron: ${job.name}`);
        if (flags.now) await inject(job.session, job.message);
        break;
      }
      case "once": {
        if (args.length < 3) {
          console.error("Usage: wopr cron once <time> <session> <message>");
          process.exit(1);
        }
        const runAt = parseTimeSpec(args[0]);
        const crons = getCrons();
        crons.push({
          name: `once-${Date.now()}`,
          schedule: "once",
          session: args[1],
          message: args.slice(2).join(" "),
          once: true,
          runAt,
        });
        saveCrons(crons);
        console.log(`Scheduled for ${new Date(runAt).toLocaleString()}`);
        break;
      }
      case "now":
        if (args.length < 2) {
          console.error("Usage: wopr cron now <session> <message>");
          process.exit(1);
        }
        await inject(args[0], args.slice(1).join(" "));
        break;
      case "remove": {
        if (!args[0]) {
          console.error("Usage: wopr cron remove <name>");
          process.exit(1);
        }
        let crons = getCrons();
        crons = crons.filter(c => c.name !== args[0]);
        saveCrons(crons);
        console.log(`Removed: ${args[0]}`);
        break;
      }
      case "list": {
        const crons = getCrons();
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
  } else if (command === "daemon") {
    switch (subcommand) {
      case "start": {
        const existing = getDaemonPid();
        if (existing) {
          console.log(`Daemon already running (PID ${existing})`);
          return;
        }
        const script = process.argv[1];
        const child = execSync(`nohup node "${script}" daemon run > /dev/null 2>&1 & echo $!`, {
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
        await runDaemon();
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
  } else if (command === "id") {
    if (subcommand === "init") {
      const identity = initId(args.includes("--force"));
      console.log(`Identity created: ${shortKey(identity.publicKey)}`);
      console.log(`Full: wopr://${identity.publicKey}`);
    } else if (subcommand === "rotate") {
      const identity = getIdentity();
      if (!identity) {
        console.log("No identity. Run: wopr id init");
        process.exit(1);
      }
      const broadcast = args.includes("--broadcast");
      const { identity: newIdentity, rotation } = rotateIdentity();
      console.log(`Keys rotated!`);
      console.log(`New ID: ${shortKey(newIdentity.publicKey)}`);
      console.log(`Old ID: ${shortKey(identity.publicKey)} (valid for 7 days)`);

      if (broadcast) {
        const peers = getPeers();
        if (peers.length === 0) {
          console.log("No peers to notify.");
        } else {
          console.log(`\nNotifying ${peers.length} peer(s)...`);
          for (const peer of peers) {
            const name = peer.name || peer.id;
            process.stdout.write(`  ${name}... `);
            const result = await sendKeyRotation(peer.id, rotation);
            if (result.code === EXIT_OK) {
              console.log("notified");
            } else {
              console.log(`failed: ${result.message}`);
            }
          }
        }
      } else {
        console.log("\nRun with --broadcast to notify peers of key change.");
      }

      // Cleanup expired key history
      cleanupExpiredKeyHistory();
    } else if (!subcommand) {
      const identity = getIdentity();
      if (!identity) {
        console.log("No identity. Run: wopr id init");
      } else {
        console.log(`WOPR ID: ${shortKey(identity.publicKey)}`);
        console.log(`Full: wopr://${identity.publicKey}`);
        console.log(`Encrypt: ${shortKey(identity.encryptPub)}`);
        if (identity.rotatedFrom) {
          console.log(`Rotated from: ${shortKey(identity.rotatedFrom)}`);
          console.log(`Rotated at: ${new Date(identity.rotatedAt!).toLocaleString()}`);
        }
      }
    } else {
      help();
    }
  } else if (command === "invite") {
    if (subcommand === "claim") {
      if (!args[0]) {
        console.error("Usage: wopr invite claim <token>");
        process.exit(1);
      }
      console.log("Claiming token (peer must be online)...");
      const result = await claimToken(args[0]);
      if (result.code === EXIT_OK) {
        console.log(`Success! Added peer: ${shortKey(result.peerKey!)}`);
        console.log(`Sessions: ${result.sessions?.join(", ")}`);
      } else {
        console.error(`Failed: ${result.message}`);
        process.exit(result.code);
      }
    } else if (subcommand) {
      // wopr invite <peer-pubkey> <session>
      const peerPubkey = subcommand;
      const sessions = args.length > 0 ? args : ["*"];
      const identity = getIdentity();
      if (!identity) {
        console.error("No identity. Run: wopr id init");
        process.exit(1);
      }
      const token = createInviteToken(peerPubkey, sessions);
      console.log(token);
      console.log(`\nFor peer: ${shortKey(peerPubkey)}`);
      console.log(`Sessions: ${sessions.join(", ")}`);
      console.log(`\nThey claim with: wopr invite claim <token>`);
    } else {
      console.error("Usage: wopr invite <peer-pubkey> <session>");
      console.error("       wopr invite claim <token>");
      process.exit(1);
    }
  } else if (command === "access") {
    const grants = getAccessGrants().filter(g => !g.revoked);
    if (grants.length === 0) {
      console.log("No one has access. Create invite: wopr invite <peer-pubkey> <session>");
    } else {
      console.log("Access grants:");
      for (const g of grants) {
        console.log(`  ${g.peerName || shortKey(g.peerKey)}`);
        console.log(`    Sessions: ${g.sessions.join(", ")}`);
      }
    }
  } else if (command === "revoke") {
    if (!subcommand) {
      console.error("Usage: wopr revoke <peer>");
      process.exit(1);
    }
    try {
      revokePeer(subcommand);
      console.log(`Revoked: ${subcommand}`);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
  } else if (command === "peers") {
    if (subcommand === "name") {
      if (!args[0] || !args[1]) {
        console.error("Usage: wopr peers name <id> <name>");
        process.exit(1);
      }
      try {
        namePeer(args[0], args.slice(1).join(" "));
        console.log(`Named peer ${args[0]} as "${args.slice(1).join(" ")}"`);
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    } else if (!subcommand) {
      const peers = getPeers();
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
    const result = await sendP2PInject(peer, session, message);

    if (result.code === EXIT_OK) {
      console.log("Delivered.");
    } else {
      console.error(result.message);
    }
    process.exit(result.code);
  } else if (command === "plugin") {
    if (subcommand === "registry") {
      const regCmd = args[0];
      switch (regCmd) {
        case "list": {
          const registries = listPluginRegistries();
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
          addPluginRegistry(args[1], args[2]);
          console.log(`Added registry: ${args[1]}`);
          break;
        case "remove":
          if (!args[1]) {
            console.error("Usage: wopr plugin registry remove <name>");
            process.exit(1);
          }
          removePluginRegistry(args[1]);
          console.log(`Removed registry: ${args[1]}`);
          break;
        default:
          help();
      }
    } else {
      switch (subcommand) {
        case "list": {
          const plugins = listPlugins();
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
            console.error("  github:   wopr plugin install github:user/wopr-discord");
            console.error("  local:    wopr plugin install ./my-plugin");
            process.exit(1);
          }
          await installPlugin(args[0]);
          break;
        }
        case "remove": {
          if (!args[0]) {
            console.error("Usage: wopr plugin remove <name>");
            process.exit(1);
          }
          await removePlugin(args[0]);
          break;
        }
        case "enable": {
          if (!args[0]) {
            console.error("Usage: wopr plugin enable <name>");
            process.exit(1);
          }
          enablePlugin(args[0]);
          console.log(`Enabled: ${args[0]}`);
          break;
        }
        case "disable": {
          if (!args[0]) {
            console.error("Usage: wopr plugin disable <name>");
            process.exit(1);
          }
          disablePlugin(args[0]);
          console.log(`Disabled: ${args[0]}`);
          break;
        }
        case "config": {
          if (!args[0]) {
            console.error("Usage: wopr plugin config <name>");
            process.exit(1);
          }
          const plugins = listPlugins();
          const plugin = plugins.find(p => p.name === args[0]);
          if (!plugin) {
            console.error(`Plugin not found: ${args[0]}`);
            process.exit(1);
          }
          const configPath = join(plugin.path, "config.json");
          const editor = process.env.EDITOR || "vi";
          // Create default config if doesn't exist
          if (!existsSync(configPath)) {
            writeFileSync(configPath, "{\n}\n");
          }
          execSync(`${editor} "${configPath}"`, { stdio: "inherit" });
          break;
        }
        case "search": {
          if (!args[0]) {
            console.error("Usage: wopr plugin search <query>");
            process.exit(1);
          }
          console.log(`Searching npm for wopr-plugin-${args[0]}...`);
          const results = await searchPlugins(args[0]);
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
    switch (subcommand) {
      case "join": {
        if (!args[0]) {
          console.error("Usage: wopr discover join <topic>");
          process.exit(1);
        }
        const identity = getIdentity();
        if (!identity) {
          console.error("No identity. Run: wopr id init");
          process.exit(1);
        }
        await initDiscovery();
        await joinTopic(args[0]);
        console.log(`Joined topic: ${args[0]}`);
        console.log("Listening for peers... (Ctrl+C to exit)");

        // Keep running to discover peers
        process.on("SIGINT", async () => {
          await shutdownDiscovery();
          process.exit(0);
        });

        // Print discovered peers periodically
        setInterval(() => {
          const peers = getTopicPeers(args[0]);
          if (peers.length > 0) {
            console.log(`\nPeers in ${args[0]}:`);
            for (const p of peers) {
              console.log(`  ${p.id}: ${JSON.stringify(p.content)}`);
            }
          }
        }, 5000);
        break;
      }
      case "leave": {
        if (!args[0]) {
          console.error("Usage: wopr discover leave <topic>");
          process.exit(1);
        }
        await initDiscovery();
        await leaveTopic(args[0]);
        console.log(`Left topic: ${args[0]}`);
        await shutdownDiscovery();
        break;
      }
      case "topics": {
        const topics = getTopics();
        if (topics.length === 0) {
          console.log("Not in any topics. Join one: wopr discover join <topic>");
        } else {
          console.log("Active topics:");
          for (const t of topics) {
            const peers = getTopicPeers(t);
            console.log(`  ${t} (${peers.length} peers)`);
          }
        }
        break;
      }
      case "peers": {
        const topic = args[0];
        const peers = topic ? getTopicPeers(topic) : getAllPeers();
        if (peers.length === 0) {
          console.log("No peers discovered yet.");
        } else {
          console.log(`Discovered peers${topic ? ` in ${topic}` : ""}:`);
          for (const p of peers) {
            console.log(`  ${p.id} (${shortKey(p.publicKey)})`);
            if (p.content) {
              console.log(`    ${JSON.stringify(p.content)}`);
            }
            if (p.topics.length > 0) {
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
        const identity = getIdentity();
        if (!identity) {
          console.error("No identity. Run: wopr id init");
          process.exit(1);
        }

        // Find peer by short ID
        const allPeers = getAllPeers();
        const targetPeer = allPeers.find(p => p.id === args[0] || shortKey(p.publicKey) === args[0]);

        if (!targetPeer) {
          console.error(`Peer not found: ${args[0]}`);
          console.error("Discover peers first: wopr discover join <topic>");
          process.exit(1);
        }

        console.log(`Requesting connection with ${targetPeer.id}...`);
        const result = await requestConnection(targetPeer.publicKey);

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
            const profile = updateProfile(content);
            console.log("Profile updated:");
            console.log(`  ID: ${profile.id}`);
            console.log(`  Content: ${JSON.stringify(profile.content)}`);
          } catch (err: any) {
            console.error(`Invalid JSON: ${err.message}`);
            process.exit(1);
          }
        } else {
          const profile = getProfile();
          if (!profile) {
            console.log("No profile set. Create one: wopr discover profile set <json>");
          } else {
            console.log("Current profile:");
            console.log(`  ID: ${profile.id}`);
            console.log(`  Content: ${JSON.stringify(profile.content, null, 2)}`);
            console.log(`  Topics: ${profile.topics.join(", ") || "(none)"}`);
            console.log(`  Updated: ${new Date(profile.updated).toLocaleString()}`);
          }
        }
        break;
      }
      default:
        help();
    }
  } else {
    // Check if it's a plugin command: wopr <plugin> <command> [args...]
    const plugins = listPlugins();
    const plugin = plugins.find(p => p.name === command);

    if (plugin) {
      // Load the plugin to get its commands
      const identity = getIdentity();
      const sessions = getSessions();

      // Create minimal injectors for CLI context
      const injectors = {
        inject: async (session: string, message: string, onStream?: StreamCallback): Promise<string> => {
          // Run inject with streaming support, silent for CLI plugin invocation
          return await inject(session, message, { silent: true, onStream });
        },
        injectPeer: async (peer: string, session: string, message: string): Promise<string> => {
          const result = await sendP2PInject(peer, session, message);
          return result.message || "";
        },
        getIdentity: () => identity ? {
          publicKey: identity.publicKey,
          shortId: shortKey(identity.publicKey),
          encryptPub: identity.encryptPub,
        } : { publicKey: "", shortId: "", encryptPub: "" },
        getSessions: () => Object.keys(sessions),
        getPeers: () => getPeers(),
      };

      try {
        const { loadPlugin } = await import("./plugins.js");
        const loadedPlugin = await loadPlugin(plugin, injectors);

        if (!loadedPlugin.commands || loadedPlugin.commands.length === 0) {
          console.error(`Plugin ${command} has no CLI commands.`);
          process.exit(1);
        }

        // Find the command
        const pluginCmd = loadedPlugin.commands.find(c => c.name === subcommand);
        if (!pluginCmd) {
          console.log(`Plugin ${command} commands:`);
          for (const cmd of loadedPlugin.commands) {
            console.log(`  wopr ${command} ${cmd.name}`);
            console.log(`    ${cmd.description}`);
          }
          process.exit(1);
        }

        // Get the context for this plugin
        const loaded = getLoadedPlugin(plugin.name);
        if (!loaded) {
          console.error(`Plugin ${command} not loaded properly.`);
          process.exit(1);
        }

        // Run the command
        await pluginCmd.handler(loaded.context, args);
      } catch (err: any) {
        console.error(`Plugin error: ${err.message}`);
        process.exit(1);
      }
    } else {
      help();
    }
  }
})();
