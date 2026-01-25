/**
 * Identity API routes
 */

import { Hono } from "hono";
import {
  getIdentity,
  initIdentity,
  shortKey,
  rotateIdentity,
} from "../../identity.js";
import { getPeers } from "../../trust.js";
import { sendKeyRotation } from "../../p2p.js";
import { cleanupExpiredKeyHistory } from "../../trust.js";
import { EXIT_OK } from "../../types.js";

export const identityRouter = new Hono();

// Get identity
identityRouter.get("/", (c) => {
  const identity = getIdentity();

  if (!identity) {
    return c.json({
      initialized: false,
    });
  }

  return c.json({
    initialized: true,
    id: shortKey(identity.publicKey),
    publicKey: identity.publicKey,
    encryptPub: identity.encryptPub,
    created: identity.created,
    rotatedFrom: identity.rotatedFrom ? shortKey(identity.rotatedFrom) : null,
    rotatedAt: identity.rotatedAt || null,
  });
});

// Initialize identity
identityRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const force = body.force || false;

  try {
    const identity = initIdentity(force);
    return c.json({
      initialized: true,
      id: shortKey(identity.publicKey),
      publicKey: identity.publicKey,
      encryptPub: identity.encryptPub,
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Rotate keys
identityRouter.post("/rotate", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const broadcast = body.broadcast || false;

  const identity = getIdentity();
  if (!identity) {
    return c.json({ error: "No identity. Initialize first." }, 400);
  }

  const { identity: newIdentity, rotation } = rotateIdentity();

  const result: any = {
    rotated: true,
    newId: shortKey(newIdentity.publicKey),
    oldId: shortKey(identity.publicKey),
    newPublicKey: newIdentity.publicKey,
    gracePeriodDays: 7,
  };

  if (broadcast) {
    const peers = getPeers();
    const notifications: { peer: string; success: boolean; message?: string }[] = [];

    for (const peer of peers) {
      const name = peer.name || peer.id;
      const sendResult = await sendKeyRotation(peer.id, rotation);
      notifications.push({
        peer: name,
        success: sendResult.code === EXIT_OK,
        message: sendResult.message,
      });
    }

    result.notifications = notifications;
  }

  // Cleanup expired key history
  cleanupExpiredKeyHistory();

  return c.json(result);
});
