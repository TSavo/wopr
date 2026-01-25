import { randomBytes } from "crypto";
import Hyperswarm from "hyperswarm";
import type { Duplex } from "stream";
import type { P2PMessage, EphemeralKeyPair, KeyRotation } from "./types.js";
import {
  EXIT_OK,
  EXIT_OFFLINE,
  EXIT_REJECTED,
  EXIT_INVALID,
  EXIT_RATE_LIMITED,
  EXIT_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
} from "./types.js";
import {
  getIdentity,
  getTopic,
  signMessage,
  verifySignature,
  shortKey,
  parseInviteToken,
  generateEphemeralKeyPair,
  encryptWithEphemeral,
  decryptWithEphemeral,
  encryptMessage,
  decryptMessage,
} from "./identity.js";
import { findPeer, isAuthorized, grantAccess, addPeer, getGrantForPeer, processPeerKeyRotation } from "./trust.js";
import { getRateLimiter, getReplayProtector } from "./rate-limit.js";

export interface SendResult {
  code: number;
  message?: string;
}

export interface ClaimResult {
  code: number;
  peerKey?: string;
  sessions?: string[];
  caps?: string[];
  message?: string;
}

// Session state for forward secrecy
interface SessionState {
  ephemeral: EphemeralKeyPair;
  peerEphemeralPub?: string;
  negotiatedVersion?: number;
}

const activeSessions = new Map<string, SessionState>();

/**
 * Perform version handshake with peer.
 * Returns negotiated version or throws on mismatch.
 */
async function performHandshake(
  socket: Duplex,
  myPubKey: string,
  ephemeral: EphemeralKeyPair
): Promise<{ version: number; peerEphemeralPub: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Handshake timeout"));
    }, 5000);

    // Send hello with supported versions and ephemeral pubkey
    const hello = signMessage<Omit<P2PMessage, "sig">>({
      v: PROTOCOL_VERSION,
      type: "hello",
      from: myPubKey,
      versions: [PROTOCOL_VERSION, MIN_PROTOCOL_VERSION],
      ephemeralPub: ephemeral.publicKey,
      nonce: randomBytes(16).toString("hex"),
      ts: Date.now(),
    });
    socket.write(JSON.stringify(hello) + "\n");

    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;

      const line = buffer.split("\n")[0];
      buffer = buffer.slice(line.length + 1);

      try {
        const msg: P2PMessage = JSON.parse(line);

        if (msg.type === "hello-ack" && msg.version !== undefined) {
          clearTimeout(timeout);
          socket.removeListener("data", onData);

          if (msg.version < MIN_PROTOCOL_VERSION) {
            reject(new Error(`Version ${msg.version} not supported`));
            return;
          }

          resolve({
            version: msg.version,
            peerEphemeralPub: msg.ephemeralPub || "",
          });
        } else if (msg.type === "hello") {
          // We're the server - respond with hello-ack
          const commonVersions = (msg.versions || [PROTOCOL_VERSION]).filter(
            (v) => v >= MIN_PROTOCOL_VERSION && v <= PROTOCOL_VERSION
          );

          if (commonVersions.length === 0) {
            clearTimeout(timeout);
            reject(new Error("No common protocol version"));
            return;
          }

          const negotiatedVersion = Math.max(...commonVersions);

          const ack = signMessage<Omit<P2PMessage, "sig">>({
            v: PROTOCOL_VERSION,
            type: "hello-ack",
            from: myPubKey,
            version: negotiatedVersion,
            ephemeralPub: ephemeral.publicKey,
            nonce: randomBytes(16).toString("hex"),
            ts: Date.now(),
          });
          socket.write(JSON.stringify(ack) + "\n");

          clearTimeout(timeout);
          socket.removeListener("data", onData);
          resolve({
            version: negotiatedVersion,
            peerEphemeralPub: msg.ephemeralPub || "",
          });
        }
      } catch {
        // Continue buffering
      }
    };

    socket.on("data", onData);
    socket.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Socket error during handshake"));
    });
  });
}

export async function sendP2PInject(
  peerIdOrName: string,
  session: string,
  message: string,
  timeoutMs = 10000
): Promise<SendResult> {
  const identity = getIdentity();
  if (!identity) {
    return { code: EXIT_INVALID, message: "No identity" };
  }

  const peer = findPeer(peerIdOrName);
  if (!peer) {
    return { code: EXIT_INVALID, message: `Peer not found: ${peerIdOrName}` };
  }

  if (!peer.sessions.includes("*") && !peer.sessions.includes(session)) {
    return { code: EXIT_REJECTED, message: `No access to session "${session}"` };
  }

  if (!peer.encryptPub) {
    return { code: EXIT_INVALID, message: "Peer has no encryption key (claim token first)" };
  }

  const topic = getTopic(peer.publicKey);
  const swarm = new Hyperswarm();

  // Generate ephemeral keypair for this session (forward secrecy)
  const ephemeral = generateEphemeralKeyPair();

  return new Promise<SendResult>((resolve) => {
    let resolved = false;
    const cleanup = async () => {
      if (!resolved) {
        resolved = true;
        await swarm.destroy();
      }
    };

    const timeout = setTimeout(async () => {
      if (!resolved) {
        await cleanup();
        resolve({ code: EXIT_OFFLINE, message: "Peer offline (timeout)" });
      }
    }, timeoutMs);

    swarm.on("connection", async (socket: Duplex) => {
      if (resolved) return;

      try {
        // Perform handshake with version negotiation
        const { version, peerEphemeralPub } = await performHandshake(
          socket,
          identity.publicKey,
          ephemeral
        );

        clearTimeout(timeout);

        // Encrypt using ephemeral keys if peer supports v2+ and has ephemeral
        let encryptedPayload: string;
        let useEphemeral = false;

        if (version >= 2 && peerEphemeralPub) {
          // Forward secrecy: use ephemeral keys
          encryptedPayload = encryptWithEphemeral(message, ephemeral.privateKey, peerEphemeralPub);
          useEphemeral = true;
        } else {
          // Fallback to static keys (v1 compatibility)
          encryptedPayload = encryptMessage(message, peer.encryptPub!);
        }

        const msg = signMessage<Omit<P2PMessage, "sig">>({
          v: version,
          type: "inject",
          from: identity.publicKey,
          encryptPub: identity.encryptPub,
          ephemeralPub: useEphemeral ? ephemeral.publicKey : undefined,
          session,
          payload: encryptedPayload,
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });

        socket.write(JSON.stringify(msg) + "\n");

        let buffer = "";
        socket.on("data", async (data: Buffer) => {
          buffer += data.toString();
          if (buffer.includes("\n")) {
            const line = buffer.split("\n")[0];
            try {
              const response: P2PMessage = JSON.parse(line);
              if (response.type === "ack") {
                await cleanup();
                resolve({ code: EXIT_OK });
              } else if (response.type === "reject") {
                await cleanup();
                const code = response.reason === "rate limited" ? EXIT_RATE_LIMITED : EXIT_REJECTED;
                resolve({ code, message: response.reason || "unauthorized" });
              }
            } catch {
              await cleanup();
              resolve({ code: EXIT_INVALID, message: "Invalid response" });
            }
          }
        });

        socket.on("error", async () => {
          if (!resolved) {
            await cleanup();
            resolve({ code: EXIT_OFFLINE, message: "Connection error" });
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        await cleanup();
        if (err instanceof Error && err.message.includes("version")) {
          resolve({ code: EXIT_VERSION_MISMATCH, message: err.message });
        } else {
          resolve({ code: EXIT_OFFLINE, message: `Handshake failed: ${err}` });
        }
      }
    });

    swarm.join(topic, { server: false, client: true });
  });
}

/**
 * Claim a token by connecting to the issuer's swarm and requesting access.
 * The issuer must be online to acknowledge the claim.
 * On success, the issuer is added to our peers list.
 */
export async function claimToken(
  tokenStr: string,
  timeoutMs = 10000
): Promise<ClaimResult> {
  const identity = getIdentity();
  if (!identity) {
    return { code: EXIT_INVALID, message: "No identity" };
  }

  let token;
  try {
    token = parseInviteToken(tokenStr);
  } catch (err) {
    return { code: EXIT_INVALID, message: `Invalid token: ${err}` };
  }

  const topic = getTopic(token.iss);
  const swarm = new Hyperswarm();
  const ephemeral = generateEphemeralKeyPair();

  return new Promise<ClaimResult>((resolve) => {
    let resolved = false;
    const cleanup = async () => {
      if (!resolved) {
        resolved = true;
        await swarm.destroy();
      }
    };

    const timeout = setTimeout(async () => {
      if (!resolved) {
        await cleanup();
        resolve({ code: EXIT_OFFLINE, message: "Issuer offline (timeout)" });
      }
    }, timeoutMs);

    swarm.on("connection", async (socket: Duplex) => {
      if (resolved) return;

      try {
        // Perform handshake
        const { version } = await performHandshake(socket, identity.publicKey, ephemeral);
        clearTimeout(timeout);

        // Send claim message
        const msg = signMessage<Omit<P2PMessage, "sig">>({
          v: version,
          type: "claim",
          from: identity.publicKey,
          encryptPub: identity.encryptPub,
          token: tokenStr,
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });

        socket.write(JSON.stringify(msg) + "\n");

        let buffer = "";
        socket.on("data", async (data: Buffer) => {
          buffer += data.toString();
          if (buffer.includes("\n")) {
            const line = buffer.split("\n")[0];
            try {
              const response: P2PMessage = JSON.parse(line);
              if (response.type === "ack") {
                addPeer(token.iss, token.ses, token.cap, response.encryptPub);
                await cleanup();
                resolve({
                  code: EXIT_OK,
                  peerKey: token.iss,
                  sessions: token.ses,
                  caps: token.cap,
                });
              } else if (response.type === "reject") {
                await cleanup();
                resolve({ code: EXIT_REJECTED, message: response.reason || "claim rejected" });
              }
            } catch {
              await cleanup();
              resolve({ code: EXIT_INVALID, message: "Invalid response" });
            }
          }
        });

        socket.on("error", async () => {
          if (!resolved) {
            await cleanup();
            resolve({ code: EXIT_OFFLINE, message: "Connection error" });
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        await cleanup();
        resolve({ code: EXIT_OFFLINE, message: `Handshake failed: ${err}` });
      }
    });

    swarm.join(topic, { server: false, client: true });
  });
}

/**
 * Send a key rotation notification to a peer.
 */
export async function sendKeyRotation(
  peerIdOrName: string,
  rotation: KeyRotation,
  timeoutMs = 10000
): Promise<SendResult> {
  const identity = getIdentity();
  if (!identity) {
    return { code: EXIT_INVALID, message: "No identity" };
  }

  const peer = findPeer(peerIdOrName);
  if (!peer) {
    return { code: EXIT_INVALID, message: `Peer not found: ${peerIdOrName}` };
  }

  const topic = getTopic(peer.publicKey);
  const swarm = new Hyperswarm();
  const ephemeral = generateEphemeralKeyPair();

  return new Promise<SendResult>((resolve) => {
    let resolved = false;
    const cleanup = async () => {
      if (!resolved) {
        resolved = true;
        await swarm.destroy();
      }
    };

    const timeout = setTimeout(async () => {
      if (!resolved) {
        await cleanup();
        resolve({ code: EXIT_OFFLINE, message: "Peer offline (timeout)" });
      }
    }, timeoutMs);

    swarm.on("connection", async (socket: Duplex) => {
      if (resolved) return;

      try {
        const { version } = await performHandshake(socket, rotation.newSignPub, ephemeral);
        clearTimeout(timeout);

        // Send key rotation message (already signed with old key)
        const msg: P2PMessage = {
          v: version,
          type: "key-rotation",
          from: rotation.oldSignPub,
          keyRotation: {
            v: rotation.v,
            oldSignPub: rotation.oldSignPub,
            newSignPub: rotation.newSignPub,
            newEncryptPub: rotation.newEncryptPub,
            reason: rotation.reason,
            effectiveAt: rotation.effectiveAt,
            gracePeriodMs: rotation.gracePeriodMs,
            sig: rotation.sig,
          },
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
          sig: rotation.sig, // Use the rotation signature
        };

        socket.write(JSON.stringify(msg) + "\n");

        let buffer = "";
        socket.on("data", async (data: Buffer) => {
          buffer += data.toString();
          if (buffer.includes("\n")) {
            const line = buffer.split("\n")[0];
            try {
              const response: P2PMessage = JSON.parse(line);
              if (response.type === "ack") {
                await cleanup();
                resolve({ code: EXIT_OK });
              } else if (response.type === "reject") {
                await cleanup();
                resolve({ code: EXIT_REJECTED, message: response.reason || "rotation rejected" });
              }
            } catch {
              await cleanup();
              resolve({ code: EXIT_INVALID, message: "Invalid response" });
            }
          }
        });

        socket.on("error", async () => {
          if (!resolved) {
            await cleanup();
            resolve({ code: EXIT_OFFLINE, message: "Connection error" });
          }
        });
      } catch (err) {
        clearTimeout(timeout);
        await cleanup();
        resolve({ code: EXIT_OFFLINE, message: `Handshake failed: ${err}` });
      }
    });

    swarm.join(topic, { server: false, client: true });
  });
}

export function createP2PListener(
  onInject: (session: string, message: string, peerKey?: string) => Promise<void>,
  onLog: (msg: string) => void
): Hyperswarm | null {
  const identity = getIdentity();
  if (!identity) {
    onLog("No identity - P2P disabled");
    return null;
  }

  const topic = getTopic(identity.publicKey);
  const swarm = new Hyperswarm();

  swarm.join(topic, { server: true, client: false });

  swarm.on("connection", (socket: Duplex) => {
    onLog("P2P connection received");
    handleConnection(socket, identity.publicKey, onInject, onLog);
  });

  onLog(`P2P listening on topic ${topic.toString("hex").slice(0, 8)}...`);
  return swarm;
}

function handleConnection(
  socket: Duplex,
  myPublicKey: string,
  onInject: (session: string, message: string, peerKey?: string) => Promise<void>,
  onLog: (msg: string) => void
): void {
  const rateLimiter = getRateLimiter();
  const replayProtector = getReplayProtector();

  // Generate ephemeral keypair for this connection
  const ephemeral = generateEphemeralKeyPair();
  let sessionState: SessionState = { ephemeral };
  let handshakeComplete = false;
  let buffer = "";

  socket.on("data", async (data: Buffer) => {
    buffer += data.toString();
    if (!buffer.includes("\n")) return;

    const line = buffer.split("\n")[0];
    buffer = buffer.slice(line.length + 1);

    let msg: P2PMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Handle hello (handshake initiation)
    if (msg.type === "hello" && !handshakeComplete) {
      const commonVersions = (msg.versions || [1]).filter(
        (v) => v >= MIN_PROTOCOL_VERSION && v <= PROTOCOL_VERSION
      );

      if (commonVersions.length === 0) {
        const reject = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "reject",
          from: myPublicKey,
          reason: "no common protocol version",
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(reject) + "\n");
        return;
      }

      const negotiatedVersion = Math.max(...commonVersions);
      sessionState.negotiatedVersion = negotiatedVersion;
      sessionState.peerEphemeralPub = msg.ephemeralPub;

      const ack = signMessage<Omit<P2PMessage, "sig">>({
        v: PROTOCOL_VERSION,
        type: "hello-ack",
        from: myPublicKey,
        version: negotiatedVersion,
        ephemeralPub: ephemeral.publicKey,
        nonce: randomBytes(16).toString("hex"),
        ts: Date.now(),
      });
      socket.write(JSON.stringify(ack) + "\n");
      handshakeComplete = true;
      onLog(`Handshake complete: v${negotiatedVersion}`);
      return;
    }

    // For non-hello messages, verify signature first
    if (msg.type !== "hello" && msg.type !== "hello-ack") {
      // Special handling for key rotation (verify with old key)
      if (msg.type === "key-rotation" && msg.keyRotation) {
        const rotation: KeyRotation = {
          ...msg.keyRotation,
          type: "key-rotation",
        };
        if (processPeerKeyRotation(rotation)) {
          onLog(`Key rotation processed for ${shortKey(msg.from)}`);
          const ack = signMessage<Omit<P2PMessage, "sig">>({
            v: PROTOCOL_VERSION,
            type: "ack",
            from: myPublicKey,
            nonce: randomBytes(16).toString("hex"),
            ts: Date.now(),
          });
          socket.write(JSON.stringify(ack) + "\n");
        } else {
          onLog(`Key rotation rejected for ${shortKey(msg.from)}`);
          const reject = signMessage<Omit<P2PMessage, "sig">>({
            v: PROTOCOL_VERSION,
            type: "reject",
            from: myPublicKey,
            reason: "invalid key rotation",
            nonce: randomBytes(16).toString("hex"),
            ts: Date.now(),
          });
          socket.write(JSON.stringify(reject) + "\n");
        }
        return;
      }

      if (!verifySignature(msg, msg.from)) {
        onLog(`Rejected: invalid signature from ${shortKey(msg.from)}`);
        rateLimiter.check(msg.from, "invalidMessages");
        return;
      }

      // Replay protection
      if (!replayProtector.check(msg.nonce, msg.ts)) {
        onLog(`Rejected: replay detected from ${shortKey(msg.from)}`);
        rateLimiter.check(msg.from, "invalidMessages");
        return;
      }
    }

    // Handle claim messages
    if (msg.type === "claim" && msg.token) {
      // Rate limit claims
      if (!rateLimiter.check(msg.from, "claims")) {
        onLog(`Rate limited: claim from ${shortKey(msg.from)}`);
        const reject = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "reject",
          from: myPublicKey,
          reason: "rate limited",
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(reject) + "\n");
        return;
      }

      onLog(`Claim request from ${shortKey(msg.from)}`);
      try {
        const token = parseInviteToken(msg.token);

        if (token.iss !== myPublicKey) {
          onLog(`Rejected claim: token not issued by us`);
          const reject = signMessage<Omit<P2PMessage, "sig">>({
            v: PROTOCOL_VERSION,
            type: "reject",
            from: myPublicKey,
            reason: "token not issued by this peer",
            nonce: randomBytes(16).toString("hex"),
            ts: Date.now(),
          });
          socket.write(JSON.stringify(reject) + "\n");
          return;
        }

        if (token.sub !== msg.from) {
          onLog(`Rejected claim: token not issued for this peer`);
          const reject = signMessage<Omit<P2PMessage, "sig">>({
            v: PROTOCOL_VERSION,
            type: "reject",
            from: myPublicKey,
            reason: "token not issued for you",
            nonce: randomBytes(16).toString("hex"),
            ts: Date.now(),
          });
          socket.write(JSON.stringify(reject) + "\n");
          return;
        }

        grantAccess(msg.from, token.ses, token.cap, msg.encryptPub);
        onLog(`Granted access to ${shortKey(msg.from)} for sessions: ${token.ses.join(", ")}`);

        const identity = getIdentity()!;
        const ack = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "ack",
          from: myPublicKey,
          encryptPub: identity.encryptPub,
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(ack) + "\n");
      } catch (err) {
        onLog(`Rejected claim: ${err}`);
        const reject = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "reject",
          from: myPublicKey,
          reason: `invalid token: ${err}`,
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(reject) + "\n");
      }
      return;
    }

    // Handle inject messages
    if (msg.type === "inject" && msg.payload && msg.session) {
      // Rate limit injects
      if (!rateLimiter.check(msg.from, "injects")) {
        onLog(`Rate limited: inject from ${shortKey(msg.from)}`);
        const reject = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "reject",
          from: myPublicKey,
          session: msg.session,
          reason: "rate limited",
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(reject) + "\n");
        return;
      }

      if (!isAuthorized(msg.from, msg.session)) {
        onLog(`Rejected: unauthorized ${shortKey(msg.from)} -> ${msg.session}`);
        const reject = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "reject",
          from: myPublicKey,
          session: msg.session,
          reason: "unauthorized",
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(reject) + "\n");
        return;
      }

      onLog(`Inject from ${shortKey(msg.from)} -> ${msg.session}`);
      try {
        let decryptedPayload: string;

        // Try ephemeral decryption first (v2+ with PFS)
        if (msg.v >= 2 && msg.ephemeralPub && sessionState.ephemeral) {
          decryptedPayload = decryptWithEphemeral(
            msg.payload,
            sessionState.ephemeral.privateKey,
            msg.ephemeralPub
          );
        } else {
          // Fallback to static key decryption
          const grant = getGrantForPeer(msg.from);
          if (!grant?.peerEncryptPub) {
            throw new Error("No encryption key for sender");
          }
          decryptedPayload = decryptMessage(msg.payload, grant.peerEncryptPub);
        }

        await onInject(msg.session, decryptedPayload, msg.from);

        const ack = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "ack",
          from: myPublicKey,
          session: msg.session,
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(ack) + "\n");
        onLog(`Delivered to ${msg.session}`);
      } catch (err) {
        onLog(`Inject failed: ${err}`);
        const reject = signMessage<Omit<P2PMessage, "sig">>({
          v: PROTOCOL_VERSION,
          type: "reject",
          from: myPublicKey,
          session: msg.session,
          reason: "inject failed",
          nonce: randomBytes(16).toString("hex"),
          ts: Date.now(),
        });
        socket.write(JSON.stringify(reject) + "\n");
      }
    }
  });
}
