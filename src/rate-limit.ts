import type { RateLimitConfig, RateLimitState, RateLimits } from "./types.js";

// Default rate limits
export const DEFAULT_LIMITS: RateLimits = {
  connections: {
    windowMs: 60000,        // 1 minute
    maxRequests: 10,        // 10 connections per minute per peer
    blockDurationMs: 300000 // Block for 5 minutes
  },
  claims: {
    windowMs: 60000,        // 1 minute
    maxRequests: 5,         // 5 claims per minute per peer
    blockDurationMs: 300000 // Block for 5 minutes
  },
  injects: {
    windowMs: 1000,         // 1 second
    maxRequests: 10,        // 10 injects per second per peer
    blockDurationMs: 60000  // Block for 1 minute
  },
  invalidMessages: {
    windowMs: 60000,        // 1 minute
    maxRequests: 3,         // 3 invalid messages = bad actor
    blockDurationMs: 600000 // Block for 10 minutes
  }
};

export class RateLimiter {
  private limits: RateLimits;
  private state: Map<string, Map<string, RateLimitState>> = new Map();

  constructor(limits: RateLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  /**
   * Check if a request is allowed.
   * Returns true if allowed, false if rate limited.
   */
  check(peerKey: string, limitType: keyof RateLimits): boolean {
    const config = this.limits[limitType];
    const state = this.getState(peerKey, limitType);
    const now = Date.now();

    // Check if blocked
    if (state.blockedUntil && now < state.blockedUntil) {
      return false;
    }

    // Clear block if expired
    if (state.blockedUntil && now >= state.blockedUntil) {
      state.blockedUntil = undefined;
      state.requests = [];
    }

    // Clean old requests outside window
    state.requests = state.requests.filter(ts => now - ts < config.windowMs);

    // Check if over limit
    if (state.requests.length >= config.maxRequests) {
      state.blockedUntil = now + config.blockDurationMs;
      return false;
    }

    // Record this request
    state.requests.push(now);
    return true;
  }

  /**
   * Check without recording (peek)
   */
  isBlocked(peerKey: string, limitType: keyof RateLimits): boolean {
    const state = this.getState(peerKey, limitType);
    const now = Date.now();

    if (state.blockedUntil && now < state.blockedUntil) {
      return true;
    }

    return false;
  }

  /**
   * Get time until unblocked (0 if not blocked)
   */
  getBlockedFor(peerKey: string, limitType: keyof RateLimits): number {
    const state = this.getState(peerKey, limitType);
    const now = Date.now();

    if (state.blockedUntil && now < state.blockedUntil) {
      return state.blockedUntil - now;
    }

    return 0;
  }

  /**
   * Manually block a peer (for detected bad behavior)
   */
  block(peerKey: string, limitType: keyof RateLimits, durationMs?: number): void {
    const config = this.limits[limitType];
    const state = this.getState(peerKey, limitType);
    state.blockedUntil = Date.now() + (durationMs ?? config.blockDurationMs);
  }

  /**
   * Unblock a peer
   */
  unblock(peerKey: string, limitType: keyof RateLimits): void {
    const state = this.getState(peerKey, limitType);
    state.blockedUntil = undefined;
    state.requests = [];
  }

  /**
   * Get current request count in window
   */
  getRequestCount(peerKey: string, limitType: keyof RateLimits): number {
    const config = this.limits[limitType];
    const state = this.getState(peerKey, limitType);
    const now = Date.now();

    return state.requests.filter(ts => now - ts < config.windowMs).length;
  }

  /**
   * Clear all state (for testing or reset)
   */
  clear(): void {
    this.state.clear();
  }

  /**
   * Clear state for a specific peer
   */
  clearPeer(peerKey: string): void {
    this.state.delete(peerKey);
  }

  private getState(peerKey: string, limitType: string): RateLimitState {
    if (!this.state.has(peerKey)) {
      this.state.set(peerKey, new Map());
    }

    const peerState = this.state.get(peerKey)!;
    if (!peerState.has(limitType)) {
      peerState.set(limitType, { requests: [] });
    }

    return peerState.get(limitType)!;
  }
}

// Replay protection
export class ReplayProtector {
  private seenNonces: Map<string, number> = new Map();
  private maxAgeMs: number;
  private maxClockSkewMs: number;

  constructor(maxAgeMs = 300000, maxClockSkewMs = 30000) {
    this.maxAgeMs = maxAgeMs;           // 5 minutes default
    this.maxClockSkewMs = maxClockSkewMs; // 30 seconds clock skew tolerance
  }

  /**
   * Check if a message should be accepted.
   * Returns true if valid, false if replay/expired.
   */
  check(nonce: string, timestamp: number): boolean {
    const now = Date.now();

    // Check timestamp is within acceptable range
    if (timestamp < now - this.maxAgeMs) {
      return false; // Too old
    }

    if (timestamp > now + this.maxClockSkewMs) {
      return false; // Too far in future (clock skew)
    }

    // Check for replay
    if (this.seenNonces.has(nonce)) {
      return false; // Replay detected
    }

    // Record nonce
    this.seenNonces.set(nonce, timestamp);

    // Cleanup old nonces periodically
    if (this.seenNonces.size > 10000) {
      this.cleanup();
    }

    return true;
  }

  /**
   * Clean up expired nonces
   */
  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.maxAgeMs;

    for (const [nonce, ts] of this.seenNonces) {
      if (ts < cutoff) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.seenNonces.clear();
  }

  /**
   * Get number of tracked nonces
   */
  get size(): number {
    return this.seenNonces.size;
  }
}

// Singleton instances for global use
let globalRateLimiter: RateLimiter | null = null;
let globalReplayProtector: ReplayProtector | null = null;

export function getRateLimiter(): RateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new RateLimiter();
  }
  return globalRateLimiter;
}

export function getReplayProtector(): ReplayProtector {
  if (!globalReplayProtector) {
    globalReplayProtector = new ReplayProtector();
  }
  return globalReplayProtector;
}
