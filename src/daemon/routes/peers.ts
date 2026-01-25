/**
 * Peers API routes
 */

import { Hono } from "hono";
import {
  getAccessGrants,
  getPeers,
  revokePeer,
  namePeer,
} from "../../trust.js";
import {
  getIdentity,
  shortKey,
  createInviteToken,
} from "../../identity.js";
import { sendP2PInject, claimToken, sendKeyRotation } from "../../p2p.js";
import { EXIT_OK } from "../../types.js";

export const peersRouter = new Hono();

// List peers you can inject to
peersRouter.get("/", (c) => {
  const peers = getPeers();
  return c.json({
    peers: peers.map(p => ({
      id: p.id,
      name: p.name || null,
      publicKey: p.publicKey,
      sessions: p.sessions,
      caps: p.caps,
      encrypted: !!p.encryptPub,
      added: p.added,
    })),
  });
});

// List who can inject to you (access grants)
peersRouter.get("/access", (c) => {
  const grants = getAccessGrants().filter(g => !g.revoked);
  return c.json({
    grants: grants.map(g => ({
      id: g.id,
      peerKey: g.peerKey,
      peerName: g.peerName || null,
      sessions: g.sessions,
      caps: g.caps,
      created: g.created,
    })),
  });
});

// Create invite for a specific peer
peersRouter.post("/invite", async (c) => {
  const body = await c.req.json();
  const { peerPubkey, sessions = ["*"] } = body;

  if (!peerPubkey) {
    return c.json({ error: "peerPubkey is required" }, 400);
  }

  const identity = getIdentity();
  if (!identity) {
    return c.json({ error: "No identity. Run: wopr id init" }, 400);
  }

  const token = createInviteToken(peerPubkey, sessions);

  return c.json({
    token,
    forPeer: shortKey(peerPubkey),
    sessions,
  });
});

// Claim an invite token
peersRouter.post("/claim", async (c) => {
  const body = await c.req.json();
  const { token } = body;

  if (!token) {
    return c.json({ error: "Token is required" }, 400);
  }

  const result = await claimToken(token);

  if (result.code === EXIT_OK) {
    return c.json({
      success: true,
      peerKey: result.peerKey,
      peerId: shortKey(result.peerKey!),
      sessions: result.sessions,
    });
  }

  return c.json({ error: result.message }, 400);
});

// Revoke peer access
peersRouter.delete("/:id", (c) => {
  const id = c.req.param("id");

  try {
    revokePeer(id);
    return c.json({ revoked: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Name a peer
peersRouter.put("/:id/name", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { name } = body;

  if (!name) {
    return c.json({ error: "Name is required" }, 400);
  }

  try {
    namePeer(id, name);
    return c.json({ success: true, id, name });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Inject to peer
peersRouter.post("/:id/inject", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { session, message } = body;

  if (!session || !message) {
    return c.json({ error: "session and message are required" }, 400);
  }

  const result = await sendP2PInject(id, session, message);

  if (result.code === EXIT_OK) {
    return c.json({
      success: true,
      message: result.message,
    });
  }

  return c.json({ error: result.message }, result.code === 1 ? 503 : 400);
});
