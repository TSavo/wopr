import Hyperswarm from "hyperswarm";
import { createHash, randomBytes } from "crypto";
import type { Profile, DiscoveryMessage, TopicState } from "./types.js";
import { EXIT_OK, EXIT_OFFLINE, EXIT_REJECTED } from "./types.js";
import { getIdentity, shortKey, signMessage, verifySignature } from "./identity.js";
import { grantAccess, addPeer } from "./trust.js";

// Active topics we're listening on
const activeTopics: Map<string, TopicState> = new Map();

// Current profile (AI-generated content)
let currentProfile: Profile | null = null;

// Swarm instance for discovery
let discoverySwarm: any = null;

// Callback for when AI needs to make decisions
type ConnectionHandler = (
  peerProfile: Profile,
  topic: string
) => Promise<{ accept: boolean; sessions?: string[]; reason?: string }>;

let connectionHandler: ConnectionHandler | null = null;

// Callback for logging
type LogFn = (msg: string) => void;
let logFn: LogFn = console.log;

/**
 * Hash a topic string to get a Hyperswarm topic buffer.
 */
export function getTopicHash(topic: string): Buffer {
  return createHash("sha256").update(`wopr:topic:${topic}`).digest();
}

/**
 * Create a signed profile. Content is freeform - AI decides what to include.
 */
export function createProfile(content: any, topics: string[] = []): Profile {
  const identity = getIdentity();
  if (!identity) throw new Error("No identity");

  const profile: Omit<Profile, "sig"> = {
    id: shortKey(identity.publicKey),
    publicKey: identity.publicKey,
    encryptPub: identity.encryptPub,
    content,
    topics,
    updated: Date.now(),
  };

  const signed = signMessage(profile);
  return signed as Profile;
}

/**
 * Update the current profile.
 */
export function updateProfile(content: any): Profile {
  const topics = Array.from(activeTopics.keys());
  currentProfile = createProfile(content, topics);
  return currentProfile;
}

/**
 * Get the current profile.
 */
export function getProfile(): Profile | null {
  return currentProfile;
}

/**
 * Verify a profile signature.
 */
export function verifyProfile(profile: Profile): boolean {
  return verifySignature(profile, profile.publicKey);
}

/**
 * Create a signed discovery message.
 */
function createDiscoveryMessage(
  type: DiscoveryMessage["type"],
  extra: Partial<DiscoveryMessage> = {}
): DiscoveryMessage {
  const identity = getIdentity();
  if (!identity) throw new Error("No identity");

  const msg: Omit<DiscoveryMessage, "sig"> = {
    v: 1,
    type,
    from: identity.publicKey,
    encryptPub: identity.encryptPub,
    nonce: randomBytes(16).toString("hex"),
    ts: Date.now(),
    ...extra,
  };

  return signMessage(msg) as DiscoveryMessage;
}

/**
 * Initialize the discovery swarm.
 */
export async function initDiscovery(
  onConnection?: ConnectionHandler,
  log?: LogFn
): Promise<void> {
  if (discoverySwarm) return;

  const identity = getIdentity();
  if (!identity) throw new Error("No identity");

  if (onConnection) connectionHandler = onConnection;
  if (log) logFn = log;

  discoverySwarm = new Hyperswarm();

  discoverySwarm.on("connection", (conn: any, info: any) => {
    handleDiscoveryConnection(conn, info);
  });

  logFn(`Discovery initialized: ${shortKey(identity.publicKey)}`);
}

/**
 * Join a topic to discover peers.
 */
export async function joinTopic(topic: string): Promise<void> {
  if (!discoverySwarm) {
    await initDiscovery();
  }

  if (activeTopics.has(topic)) {
    logFn(`Already in topic: ${topic}`);
    return;
  }

  const topicHash = getTopicHash(topic);
  const state: TopicState = {
    topic,
    joined: Date.now(),
    peers: new Map(),
  };
  activeTopics.set(topic, state);

  // Update profile with new topic list
  if (currentProfile) {
    currentProfile = createProfile(currentProfile.content, Array.from(activeTopics.keys()));
  }

  // Join the swarm topic
  const discovery = discoverySwarm.join(topicHash, { server: true, client: true });
  await discovery.flushed();

  logFn(`Joined topic: ${topic}`);
}

/**
 * Leave a topic.
 */
export async function leaveTopic(topic: string): Promise<void> {
  if (!activeTopics.has(topic)) return;

  const topicHash = getTopicHash(topic);

  // Announce withdrawal to connected peers
  const state = activeTopics.get(topic)!;
  for (const [peerKey, _] of state.peers) {
    // Could send withdraw message here if we had peer connections tracked
  }

  activeTopics.delete(topic);

  // Update profile
  if (currentProfile) {
    currentProfile = createProfile(currentProfile.content, Array.from(activeTopics.keys()));
  }

  // Leave the swarm topic
  await discoverySwarm.leave(topicHash);

  logFn(`Left topic: ${topic}`);
}

/**
 * Get list of active topics.
 */
export function getTopics(): string[] {
  return Array.from(activeTopics.keys());
}

/**
 * Get peers discovered in a topic.
 */
export function getTopicPeers(topic: string): Profile[] {
  const state = activeTopics.get(topic);
  if (!state) return [];
  return Array.from(state.peers.values());
}

/**
 * Get all discovered peers across all topics.
 */
export function getAllPeers(): Profile[] {
  const seen = new Set<string>();
  const peers: Profile[] = [];

  for (const state of activeTopics.values()) {
    for (const [key, profile] of state.peers) {
      if (!seen.has(key)) {
        seen.add(key);
        peers.push(profile);
      }
    }
  }

  return peers;
}

/**
 * Handle an incoming discovery connection.
 */
async function handleDiscoveryConnection(conn: any, info: any): Promise<void> {
  const identity = getIdentity();
  if (!identity) {
    conn.destroy();
    return;
  }

  let peerProfile: Profile | null = null;
  let peerKey: string | null = null;

  conn.on("data", async (data: Buffer) => {
    try {
      const msg: DiscoveryMessage = JSON.parse(data.toString());

      // Verify signature
      if (!verifySignature(msg, msg.from)) {
        logFn(`Invalid signature from ${shortKey(msg.from)}`);
        conn.destroy();
        return;
      }

      peerKey = msg.from;

      switch (msg.type) {
        case "announce":
          if (msg.profile && verifyProfile(msg.profile)) {
            peerProfile = msg.profile;
            // Store in relevant topic
            if (msg.topic && activeTopics.has(msg.topic)) {
              activeTopics.get(msg.topic)!.peers.set(msg.from, msg.profile);
            }
            logFn(`Discovered: ${msg.profile.id} in ${msg.topic || "unknown"}`);

            // Send our profile back
            if (currentProfile && msg.topic) {
              const response = createDiscoveryMessage("announce", {
                topic: msg.topic,
                profile: currentProfile,
              });
              conn.write(JSON.stringify(response));
            }
          }
          break;

        case "withdraw":
          if (msg.topic && activeTopics.has(msg.topic)) {
            activeTopics.get(msg.topic)!.peers.delete(msg.from);
            logFn(`Peer left: ${shortKey(msg.from)} from ${msg.topic}`);
          }
          break;

        case "profile-request":
          if (currentProfile) {
            const response = createDiscoveryMessage("profile-response", {
              profile: currentProfile,
            });
            conn.write(JSON.stringify(response));
          }
          break;

        case "profile-response":
          if (msg.profile && verifyProfile(msg.profile)) {
            peerProfile = msg.profile;
            logFn(`Received profile: ${msg.profile.id}`);
          }
          break;

        case "connect-request":
          logFn(`Connection request from: ${shortKey(msg.from)}`);

          if (connectionHandler && peerProfile) {
            const topic = msg.topic || "unknown";
            const decision = await connectionHandler(peerProfile, topic);

            if (decision.accept) {
              // Grant them access to specified sessions
              const sessions = decision.sessions || [];
              grantAccess(msg.from, sessions, ["inject"], msg.encryptPub);

              // Add them as a peer we can inject to
              addPeer(msg.from, sessions, ["inject"], msg.encryptPub);

              const response = createDiscoveryMessage("connect-response", {
                accepted: true,
                sessions,
                reason: decision.reason || "Welcome",
              });
              conn.write(JSON.stringify(response));
              logFn(`Accepted connection: ${shortKey(msg.from)} -> sessions: ${sessions.join(", ")}`);
            } else {
              const response = createDiscoveryMessage("connect-response", {
                accepted: false,
                reason: decision.reason || "Connection declined",
              });
              conn.write(JSON.stringify(response));
              logFn(`Rejected connection: ${shortKey(msg.from)} - ${decision.reason}`);
            }
          } else {
            // No handler or no profile - reject
            const response = createDiscoveryMessage("connect-response", {
              accepted: false,
              reason: "Not accepting connections",
            });
            conn.write(JSON.stringify(response));
          }
          break;

        case "connect-response":
          if (msg.accepted) {
            // They accepted - store them as a peer
            addPeer(msg.from, msg.sessions || [], ["inject"], msg.encryptPub);
            logFn(`Connection accepted by: ${shortKey(msg.from)} -> sessions: ${msg.sessions?.join(", ")}`);
          } else {
            logFn(`Connection rejected by: ${shortKey(msg.from)} - ${msg.reason}`);
          }
          break;
      }
    } catch (err) {
      logFn(`Discovery message error: ${err}`);
    }
  });

  conn.on("error", (err: any) => {
    logFn(`Discovery connection error: ${err.message}`);
  });

  conn.on("close", () => {
    // Connection closed
  });

  // Send our announcement if we have a profile
  if (currentProfile) {
    // Find which topic this connection might be for
    // (Hyperswarm doesn't directly tell us, but we can announce on all our topics)
    for (const topic of activeTopics.keys()) {
      const announcement = createDiscoveryMessage("announce", {
        topic,
        profile: currentProfile,
      });
      conn.write(JSON.stringify(announcement));
    }
  }
}

/**
 * Request connection with a discovered peer.
 */
export async function requestConnection(
  peerPubkey: string,
  topic?: string
): Promise<{ code: number; message: string; sessions?: string[] }> {
  if (!discoverySwarm) {
    return { code: EXIT_OFFLINE, message: "Discovery not initialized" };
  }

  const identity = getIdentity();
  if (!identity) {
    return { code: EXIT_OFFLINE, message: "No identity" };
  }

  // Find peer in our discovered peers
  let peerProfile: Profile | null = null;
  for (const state of activeTopics.values()) {
    const profile = state.peers.get(peerPubkey);
    if (profile) {
      peerProfile = profile;
      break;
    }
  }

  if (!peerProfile) {
    return { code: EXIT_OFFLINE, message: "Peer not found in discovered peers" };
  }

  return new Promise((resolve) => {
    const topicHash = getTopicHash(topic || peerProfile!.topics[0] || "global");

    // Connect to peer's topic
    const conn = discoverySwarm.connect(Buffer.from(peerProfile!.publicKey, "base64"));

    const timeout = setTimeout(() => {
      conn.destroy();
      resolve({ code: EXIT_OFFLINE, message: "Connection timeout" });
    }, 30000);

    conn.on("open", () => {
      // Send connect request
      const request = createDiscoveryMessage("connect-request", {
        topic,
        profile: currentProfile || undefined,
      });
      conn.write(JSON.stringify(request));
    });

    conn.on("data", (data: Buffer) => {
      try {
        const msg: DiscoveryMessage = JSON.parse(data.toString());

        if (msg.type === "connect-response") {
          clearTimeout(timeout);

          if (msg.accepted) {
            // Store them as a peer
            addPeer(msg.from, msg.sessions || [], ["inject"], msg.encryptPub);
            resolve({
              code: EXIT_OK,
              message: "Connected",
              sessions: msg.sessions,
            });
          } else {
            resolve({
              code: EXIT_REJECTED,
              message: msg.reason || "Connection rejected",
            });
          }

          conn.destroy();
        }
      } catch (err) {
        // Ignore parse errors
      }
    });

    conn.on("error", (err: any) => {
      clearTimeout(timeout);
      resolve({ code: EXIT_OFFLINE, message: err.message });
    });
  });
}

/**
 * Shutdown discovery.
 */
export async function shutdownDiscovery(): Promise<void> {
  if (discoverySwarm) {
    await discoverySwarm.destroy();
    discoverySwarm = null;
  }
  activeTopics.clear();
  currentProfile = null;
  logFn("Discovery shutdown");
}

/**
 * Set the connection handler (for AI to make decisions).
 */
export function setConnectionHandler(handler: ConnectionHandler): void {
  connectionHandler = handler;
}

/**
 * Set the log function.
 */
export function setLogFunction(fn: LogFn): void {
  logFn = fn;
}
