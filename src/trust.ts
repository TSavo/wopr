import { existsSync, readFileSync, writeFileSync } from "fs";
import type { AccessGrant, Peer, KeyRotation, KeyHistory, InviteRecord } from "./types.js";
import { ACCESS_FILE, PEERS_FILE, INVITES_FILE } from "./paths.js";
import { getIdentity, initIdentity, shortKey, parseInviteToken, verifyKeyRotation, isInGracePeriod } from "./identity.js";

export function getAccessGrants(): AccessGrant[] {
  if (!existsSync(ACCESS_FILE)) return [];
  return JSON.parse(readFileSync(ACCESS_FILE, "utf-8"));
}

export function saveAccessGrants(grants: AccessGrant[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify(grants, null, 2), { mode: 0o600 });
}

export function getPeers(): Peer[] {
  if (!existsSync(PEERS_FILE)) return [];
  return JSON.parse(readFileSync(PEERS_FILE, "utf-8"));
}

export function savePeers(peers: Peer[]): void {
  writeFileSync(PEERS_FILE, JSON.stringify(peers, null, 2), { mode: 0o600 });
}

export function getInvites(): InviteRecord[] {
  if (!existsSync(INVITES_FILE)) return [];
  return JSON.parse(readFileSync(INVITES_FILE, "utf-8"));
}

export function saveInvites(invites: InviteRecord[]): void {
  writeFileSync(INVITES_FILE, JSON.stringify(invites, null, 2), { mode: 0o600 });
}

/**
 * Check if a sender is authorized for a session.
 * Also checks key history for rotated keys still in grace period.
 */
export function isAuthorized(senderKey: string, session: string): boolean {
  const grants = getAccessGrants();

  // Check current key
  let grant = grants.find(g =>
    !g.revoked &&
    g.peerKey === senderKey &&
    (g.sessions.includes("*") || g.sessions.includes(session)) &&
    g.caps.includes("inject")
  );

  if (grant) return true;

  // Check key history (for rotated keys in grace period)
  for (const g of grants) {
    if (g.revoked || !g.keyHistory) continue;
    if (!g.sessions.includes("*") && !g.sessions.includes(session)) continue;
    if (!g.caps.includes("inject")) continue;

    for (const history of g.keyHistory) {
      if (history.publicKey === senderKey) {
        // Check if still in grace period
        if (history.validUntil && Date.now() < history.validUntil) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Get grant for peer, including by historical keys.
 */
export function getGrantForPeer(peerKey: string): AccessGrant | undefined {
  const grants = getAccessGrants();

  // Check current key
  let grant = grants.find(g => !g.revoked && g.peerKey === peerKey);
  if (grant) return grant;

  // Check key history
  for (const g of grants) {
    if (g.revoked || !g.keyHistory) continue;
    for (const history of g.keyHistory) {
      if (history.publicKey === peerKey) {
        return g;
      }
    }
  }

  return undefined;
}

/**
 * Find peer by ID, name, or public key.
 * Also searches key history for rotated keys.
 */
export function findPeer(idOrName: string): Peer | undefined {
  const peers = getPeers();

  // Direct match
  let peer = peers.find(p =>
    p.id === idOrName ||
    p.name?.toLowerCase() === idOrName.toLowerCase() ||
    p.publicKey === idOrName
  );

  if (peer) return peer;

  // Search key history
  for (const p of peers) {
    if (!p.keyHistory) continue;
    for (const history of p.keyHistory) {
      if (history.publicKey === idOrName) {
        return p;
      }
    }
  }

  return undefined;
}

export function useInvite(tokenStr: string): Peer {
  const token = parseInviteToken(tokenStr);

  // Ensure we have identity
  let identity = getIdentity();
  if (!identity) {
    identity = initIdentity();
  }

  const peers = getPeers();
  const peerShort = shortKey(token.iss);

  const existing = peers.find(p => p.publicKey === token.iss);
  if (existing) {
    existing.sessions = Array.from(new Set([...existing.sessions, ...token.ses]));
    existing.caps = Array.from(new Set([...existing.caps, ...token.cap]));
    savePeers(peers);
    return existing;
  }

  const peer: Peer = {
    id: peerShort,
    publicKey: token.iss,
    sessions: token.ses,
    caps: token.cap,
    added: Date.now(),
  };

  peers.push(peer);
  savePeers(peers);
  return peer;
}

export function revokePeer(idOrName: string): void {
  const grants = getAccessGrants();
  const idx = grants.findIndex(g =>
    !g.revoked && (
      shortKey(g.peerKey) === idOrName ||
      g.peerName?.toLowerCase() === idOrName.toLowerCase() ||
      g.id === idOrName ||
      g.peerKey === idOrName
    )
  );

  if (idx === -1) {
    throw new Error(`No active grant found for "${idOrName}"`);
  }

  grants[idx].revoked = true;
  saveAccessGrants(grants);
}

export function namePeer(idOrKey: string, name: string): void {
  const peers = getPeers();
  const peer = peers.find(p => p.id === idOrKey || p.publicKey === idOrKey);

  if (!peer) {
    throw new Error(`Peer not found: ${idOrKey}`);
  }

  peer.name = name;
  savePeers(peers);
}

export function forgetPeer(idOrName: string): void {
  const peers = getPeers();
  const remaining = peers.filter(p =>
    !(
      p.id === idOrName ||
      p.publicKey === idOrName ||
      p.name?.toLowerCase() === idOrName.toLowerCase()
    )
  );

  if (remaining.length === peers.length) {
    throw new Error(`Peer not found: ${idOrName}`);
  }

  savePeers(remaining);
}

export function updatePeerAccess(idOrName: string, sessions: string[], caps?: string[]): Peer {
  const peers = getPeers();
  const peer = peers.find(p =>
    p.id === idOrName ||
    p.publicKey === idOrName ||
    p.name?.toLowerCase() === idOrName.toLowerCase()
  );

  if (!peer) {
    throw new Error(`Peer not found: ${idOrName}`);
  }

  peer.sessions = sessions;
  if (caps) peer.caps = caps;
  savePeers(peers);
  return peer;
}

export function grantAccess(peerKey: string, sessions: string[], caps: string[], encryptPub?: string): AccessGrant {
  const grants = getAccessGrants();

  // Check if already granted
  const existing = grants.find(g => g.peerKey === peerKey && !g.revoked);
  if (existing) {
    existing.sessions = Array.from(new Set([...existing.sessions, ...sessions]));
    existing.caps = Array.from(new Set([...existing.caps, ...caps]));
    if (encryptPub) existing.peerEncryptPub = encryptPub;
    saveAccessGrants(grants);
    return existing;
  }

  const grant: AccessGrant = {
    id: `grant-${Date.now()}`,
    peerKey,
    peerEncryptPub: encryptPub,
    sessions,
    caps,
    created: Date.now(),
  };

  grants.push(grant);
  saveAccessGrants(grants);
  return grant;
}

export function updateAccessGrant(idOrName: string, sessions: string[], caps?: string[]): AccessGrant {
  const grants = getAccessGrants();
  const grant = grants.find(g =>
    !g.revoked &&
    (
      shortKey(g.peerKey) === idOrName ||
      g.peerName?.toLowerCase() === idOrName.toLowerCase() ||
      g.id === idOrName ||
      g.peerKey === idOrName
    )
  );

  if (!grant) {
    throw new Error(`No active grant found for "${idOrName}"`);
  }

  grant.sessions = sessions;
  if (caps) grant.caps = caps;
  saveAccessGrants(grants);
  return grant;
}

export function addPeer(publicKey: string, sessions: string[], caps: string[], encryptPub?: string): Peer {
  const peers = getPeers();
  const peerShort = shortKey(publicKey);

  const existing = peers.find(p => p.publicKey === publicKey);
  if (existing) {
    existing.sessions = Array.from(new Set([...existing.sessions, ...sessions]));
    existing.caps = Array.from(new Set([...existing.caps, ...caps]));
    if (encryptPub) existing.encryptPub = encryptPub;
    savePeers(peers);
    return existing;
  }

  const peer: Peer = {
    id: peerShort,
    publicKey,
    encryptPub,
    sessions,
    caps,
    added: Date.now(),
  };

  peers.push(peer);
  savePeers(peers);
  return peer;
}

export function recordInvite(tokenStr: string): InviteRecord {
  const token = parseInviteToken(tokenStr);
  const invites = getInvites();

  const existing = invites.find(invite => invite.token === tokenStr);
  if (existing) {
    return existing;
  }

  const record: InviteRecord = {
    token: tokenStr,
    peerKey: token.sub,
    sessions: token.ses,
    created: Date.now(),
    expires: token.exp,
  };

  invites.push(record);
  saveInvites(invites);
  return record;
}

export function markInviteClaimed(tokenStr: string, claimedBy: string): void {
  const invites = getInvites();
  const invite = invites.find(i => i.token === tokenStr);
  if (!invite) return;
  if (!invite.claimedAt) {
    invite.claimedAt = Date.now();
    invite.claimedBy = claimedBy;
    saveInvites(invites);
  }
}

export function removeInvite(tokenStr: string): void {
  const invites = getInvites();
  const remaining = invites.filter(i => i.token !== tokenStr);
  if (remaining.length === invites.length) {
    throw new Error("Invite not found");
  }
  saveInvites(remaining);
}

// ============================================
// Key Rotation Handling
// ============================================

/**
 * Process a key rotation message from a peer.
 * Updates the peer's keys and adds old key to history.
 */
export function processPeerKeyRotation(rotation: KeyRotation): boolean {
  // Verify the rotation is valid
  if (!verifyKeyRotation(rotation)) {
    return false;
  }

  const grants = getAccessGrants();
  const peers = getPeers();

  // Find grant by old key
  const grantIdx = grants.findIndex(g => g.peerKey === rotation.oldSignPub && !g.revoked);
  if (grantIdx !== -1) {
    const grant = grants[grantIdx];

    // Add old key to history
    const historyEntry: KeyHistory = {
      publicKey: grant.peerKey,
      encryptPub: grant.peerEncryptPub || "",
      validFrom: grant.created,
      validUntil: rotation.effectiveAt + rotation.gracePeriodMs,
      rotationReason: rotation.reason,
    };

    if (!grant.keyHistory) grant.keyHistory = [];
    grant.keyHistory.push(historyEntry);

    // Update to new keys
    grant.peerKey = rotation.newSignPub;
    grant.peerEncryptPub = rotation.newEncryptPub;

    saveAccessGrants(grants);
  }

  // Find peer by old key
  const peerIdx = peers.findIndex(p => p.publicKey === rotation.oldSignPub);
  if (peerIdx !== -1) {
    const peer = peers[peerIdx];

    // Add old key to history
    const historyEntry: KeyHistory = {
      publicKey: peer.publicKey,
      encryptPub: peer.encryptPub || "",
      validFrom: peer.added,
      validUntil: rotation.effectiveAt + rotation.gracePeriodMs,
      rotationReason: rotation.reason,
    };

    if (!peer.keyHistory) peer.keyHistory = [];
    peer.keyHistory.push(historyEntry);

    // Update to new keys
    peer.publicKey = rotation.newSignPub;
    peer.encryptPub = rotation.newEncryptPub;
    peer.id = shortKey(rotation.newSignPub);

    savePeers(peers);
  }

  return grantIdx !== -1 || peerIdx !== -1;
}

/**
 * Clean up expired key history entries.
 */
export function cleanupExpiredKeyHistory(): void {
  const now = Date.now();
  const grants = getAccessGrants();
  const peers = getPeers();
  let modified = false;

  for (const grant of grants) {
    if (!grant.keyHistory) continue;
    const before = grant.keyHistory.length;
    grant.keyHistory = grant.keyHistory.filter(h => !h.validUntil || h.validUntil > now);
    if (grant.keyHistory.length !== before) modified = true;
  }

  for (const peer of peers) {
    if (!peer.keyHistory) continue;
    const before = peer.keyHistory.length;
    peer.keyHistory = peer.keyHistory.filter(h => !h.validUntil || h.validUntil > now);
    if (peer.keyHistory.length !== before) modified = true;
  }

  if (modified) {
    saveAccessGrants(grants);
    savePeers(peers);
  }
}

/**
 * Get all known keys for a peer (current + historical).
 */
export function getAllPeerKeys(peerKey: string): string[] {
  const keys: string[] = [peerKey];

  const grants = getAccessGrants();
  for (const grant of grants) {
    if (grant.peerKey === peerKey && grant.keyHistory) {
      for (const h of grant.keyHistory) {
        if (!keys.includes(h.publicKey)) {
          keys.push(h.publicKey);
        }
      }
    }
  }

  const peers = getPeers();
  for (const peer of peers) {
    if (peer.publicKey === peerKey && peer.keyHistory) {
      for (const h of peer.keyHistory) {
        if (!keys.includes(h.publicKey)) {
          keys.push(h.publicKey);
        }
      }
    }
  }

  return keys;
}
