/**
 * Discovery API routes
 */

import { Hono } from "hono";
import {
  initDiscovery,
  joinTopic,
  leaveTopic,
  getTopics,
  getTopicPeers,
  getAllPeers,
  updateProfile,
  getProfile,
  requestConnection,
  shutdownDiscovery,
} from "../../discovery.js";
import { getIdentity, shortKey } from "../../identity.js";
import { EXIT_OK } from "../../types.js";

export const discoverRouter = new Hono();

// Initialize discovery (if not already)
let discoveryInitialized = false;

async function ensureDiscovery() {
  if (!discoveryInitialized) {
    await initDiscovery();
    discoveryInitialized = true;
  }
}

// Get discovery status
discoverRouter.get("/", async (c) => {
  const topics = getTopics();
  const profile = getProfile();

  return c.json({
    active: topics.length > 0,
    topics,
    profile: profile ? {
      id: profile.id,
      content: profile.content,
      topics: profile.topics,
      updated: profile.updated,
    } : null,
  });
});

// Join a topic
discoverRouter.post("/topics", async (c) => {
  const body = await c.req.json();
  const { topic } = body;

  if (!topic) {
    return c.json({ error: "topic is required" }, 400);
  }

  const identity = getIdentity();
  if (!identity) {
    return c.json({ error: "No identity. Initialize first." }, 400);
  }

  await ensureDiscovery();
  await joinTopic(topic);

  return c.json({ joined: true, topic });
});

// Leave a topic
discoverRouter.delete("/topics/:topic", async (c) => {
  const topic = c.req.param("topic");

  await ensureDiscovery();
  await leaveTopic(topic);

  return c.json({ left: true, topic });
});

// List topics
discoverRouter.get("/topics", (c) => {
  const topics = getTopics();
  return c.json({
    topics: topics.map(t => ({
      name: t,
      peerCount: getTopicPeers(t).length,
    })),
  });
});

// Get peers in a topic
discoverRouter.get("/topics/:topic/peers", (c) => {
  const topic = c.req.param("topic");
  const peers = getTopicPeers(topic);

  return c.json({
    topic,
    peers: peers.map(p => ({
      id: p.id,
      publicKey: p.publicKey,
      content: p.content,
      updated: p.updated,
    })),
  });
});

// Get all discovered peers
discoverRouter.get("/peers", (c) => {
  const peers = getAllPeers();

  return c.json({
    peers: peers.map(p => ({
      id: p.id,
      publicKey: p.publicKey,
      shortKey: shortKey(p.publicKey),
      content: p.content,
      topics: p.topics,
      updated: p.updated,
    })),
  });
});

// Request connection with peer
discoverRouter.post("/connect", async (c) => {
  const body = await c.req.json();
  const { peerId } = body;

  if (!peerId) {
    return c.json({ error: "peerId is required" }, 400);
  }

  const identity = getIdentity();
  if (!identity) {
    return c.json({ error: "No identity. Initialize first." }, 400);
  }

  // Find peer by short ID or full key
  const allPeers = getAllPeers();
  const targetPeer = allPeers.find(p =>
    p.id === peerId ||
    shortKey(p.publicKey) === peerId ||
    p.publicKey === peerId
  );

  if (!targetPeer) {
    return c.json({ error: "Peer not found. Discover peers first." }, 404);
  }

  const result = await requestConnection(targetPeer.publicKey);

  if (result.code === EXIT_OK) {
    return c.json({
      connected: true,
      peerId: targetPeer.id,
      sessions: result.sessions,
    });
  }

  return c.json({ error: result.message }, 400);
});

// Get/set profile
discoverRouter.get("/profile", (c) => {
  const profile = getProfile();

  if (!profile) {
    return c.json({ profile: null });
  }

  return c.json({
    profile: {
      id: profile.id,
      publicKey: profile.publicKey,
      content: profile.content,
      topics: profile.topics,
      updated: profile.updated,
    },
  });
});

discoverRouter.put("/profile", async (c) => {
  const body = await c.req.json();
  const { content } = body;

  if (!content || typeof content !== "object") {
    return c.json({ error: "content object is required" }, 400);
  }

  const profile = updateProfile(content);

  return c.json({
    updated: true,
    profile: {
      id: profile.id,
      content: profile.content,
      topics: profile.topics,
      updated: profile.updated,
    },
  });
});
