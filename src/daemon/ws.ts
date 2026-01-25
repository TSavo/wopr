/**
 * WebSocket handler for real-time streaming
 */

import type { StreamMessage } from "../types.js";

// Simple interface for what we need from WebSocket
interface WS {
  send(data: string): void;
}

// Connected WebSocket clients
const clients = new Set<WS>();

// Subscription tracking: client -> Set of session names
const subscriptions = new Map<WS, Set<string>>();

export function setupWebSocket(ws: WS): void {
  clients.add(ws);
  subscriptions.set(ws, new Set());

  // Send welcome
  ws.send(JSON.stringify({ type: "connected", message: "WOPR WebSocket connected" }));
}

export function handleWebSocketMessage(ws: WS, data: string): void {
  try {
    const msg = JSON.parse(data);
    handleMessage(ws, msg);
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
  }
}

export function handleWebSocketClose(ws: WS): void {
  clients.delete(ws);
  subscriptions.delete(ws);
}

function handleMessage(ws: WS, msg: any): void {
  switch (msg.type) {
    case "subscribe": {
      // Subscribe to session events
      const sessions = msg.sessions as string[] | undefined;
      if (sessions && Array.isArray(sessions)) {
        const subs = subscriptions.get(ws)!;
        sessions.forEach(s => subs.add(s));
        ws.send(JSON.stringify({ type: "subscribed", sessions }));
      } else if (msg.session) {
        subscriptions.get(ws)!.add(msg.session);
        ws.send(JSON.stringify({ type: "subscribed", sessions: [msg.session] }));
      }
      break;
    }

    case "unsubscribe": {
      const sessions = msg.sessions as string[] | undefined;
      if (sessions && Array.isArray(sessions)) {
        const subs = subscriptions.get(ws)!;
        sessions.forEach(s => subs.delete(s));
        ws.send(JSON.stringify({ type: "unsubscribed", sessions }));
      } else if (msg.session) {
        subscriptions.get(ws)!.delete(msg.session);
        ws.send(JSON.stringify({ type: "unsubscribed", sessions: [msg.session] }));
      }
      break;
    }

    case "ping":
      ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      break;

    default:
      ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
  }
}

/**
 * Broadcast a stream event to all subscribed clients
 */
export function broadcastStream(session: string, from: string, message: StreamMessage): void {
  const event = {
    type: "stream",
    session,
    from,
    message,
    ts: Date.now(),
  };

  const payload = JSON.stringify(event);

  for (const [client, subs] of subscriptions) {
    // Send if subscribed to this session or to "*" (all)
    if (subs.has(session) || subs.has("*")) {
      try {
        client.send(payload);
      } catch {
        // Client disconnected
        clients.delete(client);
        subscriptions.delete(client);
      }
    }
  }
}

/**
 * Broadcast an injection completion to all subscribed clients
 */
export function broadcastInjection(
  session: string,
  from: string,
  message: string,
  response: string
): void {
  const event = {
    type: "injection",
    session,
    from,
    message,
    response,
    ts: Date.now(),
  };

  const payload = JSON.stringify(event);

  for (const [client, subs] of subscriptions) {
    if (subs.has(session) || subs.has("*")) {
      try {
        client.send(payload);
      } catch {
        clients.delete(client);
        subscriptions.delete(client);
      }
    }
  }
}

/**
 * Broadcast any message to all connected clients
 */
export function broadcast(event: any): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    try {
      client.send(payload);
    } catch {
      clients.delete(client);
      subscriptions.delete(client);
    }
  }
}

/**
 * Get number of connected clients
 */
export function getClientCount(): number {
  return clients.size;
}
