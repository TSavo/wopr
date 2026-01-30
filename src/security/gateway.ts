/**
 * WOPR Security Gateway
 *
 * Gateway sessions act as choke points for untrusted traffic:
 * - Receive injections from untrusted sources
 * - Validate requests against policy
 * - Forward to appropriate privileged sessions
 * - Return results to original requester
 *
 * Untrusted P2P sessions cannot directly inject into privileged sessions.
 * They must go through a gateway.
 */

import { logger } from "../logger.js";
import {
  type InjectionSource,
  type TrustLevel,
  type Capability,
  createInjectionSource,
} from "./types.js";
import {
  getSecurityConfig,
  isGatewaySession,
  getGatewayRules,
  canGatewayForward,
} from "./policy.js";
import { SecurityContext, createSecurityContext } from "./context.js";

// ============================================================================
// Gateway Configuration
// ============================================================================

/**
 * Gateway forward rules
 */
export interface GatewayForwardRules {
  /** Sessions this gateway can forward to */
  allowForwardTo: string[];

  /** Action types allowed */
  allowActions?: string[];

  /** Require owner approval for forwards */
  requireApproval?: boolean;

  /** Rate limit for forwards */
  rateLimit?: {
    perMinute: number;
  };
}

/**
 * Gateway forward request
 */
export interface ForwardRequest {
  /** Unique request ID */
  requestId: string;

  /** Source session (gateway) */
  sourceSession: string;

  /** Target session */
  targetSession: string;

  /** Original requester info */
  originalSource: InjectionSource;

  /** Message to forward */
  message: string;

  /** Action type (for filtering) */
  actionType?: string;

  /** Timestamp */
  timestamp: number;

  /** Request status */
  status: "pending" | "approved" | "rejected" | "completed" | "expired";

  /** Response (when completed) */
  response?: string;

  /** Rejection reason */
  rejectionReason?: string;
}

// ============================================================================
// Request Queue
// ============================================================================

/** Pending forward requests (for approval mode) */
const pendingRequests: Map<string, ForwardRequest> = new Map();

/** Rate limit tracking */
const rateLimitTracking: Map<string, { count: number; resetAt: number }> =
  new Map();

// ============================================================================
// Gateway Functions
// ============================================================================

/**
 * Check if a session is configured as a gateway
 */
export function isGateway(sessionName: string): boolean {
  return isGatewaySession(sessionName);
}

/**
 * Get the forward rules for a gateway session
 */
export function getForwardRules(
  sessionName: string
): GatewayForwardRules | null {
  const rules = getGatewayRules(sessionName);
  return rules ?? null;
}

/**
 * Check if a gateway can forward to a target session
 */
export function canForwardTo(
  gatewaySession: string,
  targetSession: string
): boolean {
  const result = canGatewayForward(gatewaySession, targetSession);
  return result.allowed;
}

/**
 * Create a forward request
 */
export function createForwardRequest(
  gatewaySession: string,
  targetSession: string,
  message: string,
  originalSource: InjectionSource,
  actionType?: string
): ForwardRequest {
  const requestId = generateRequestId();

  const request: ForwardRequest = {
    requestId,
    sourceSession: gatewaySession,
    targetSession,
    originalSource,
    message,
    actionType,
    timestamp: Date.now(),
    status: "pending",
  };

  return request;
}

/**
 * Validate a forward request against policy
 */
export function validateForwardRequest(
  request: ForwardRequest,
  gatewayContext: SecurityContext
): { valid: boolean; reason?: string } {
  // Check gateway has forward capability
  if (!gatewayContext.canForward()) {
    return { valid: false, reason: "Session is not authorized to forward" };
  }

  // Check target is allowed
  if (!canForwardTo(request.sourceSession, request.targetSession)) {
    return {
      valid: false,
      reason: `Cannot forward to session: ${request.targetSession}`,
    };
  }

  // Get forward rules
  const rules = getForwardRules(request.sourceSession);
  if (!rules) {
    return { valid: false, reason: "No forward rules configured" };
  }

  // Check action type if specified
  if (request.actionType && rules.allowActions) {
    if (!rules.allowActions.includes(request.actionType)) {
      return {
        valid: false,
        reason: `Action type not allowed: ${request.actionType}`,
      };
    }
  }

  // Check rate limit
  if (rules.rateLimit) {
    const rateLimitKey = `${request.sourceSession}:${request.targetSession}`;
    const now = Date.now();
    const tracking = rateLimitTracking.get(rateLimitKey);

    if (tracking) {
      if (now < tracking.resetAt) {
        if (tracking.count >= rules.rateLimit.perMinute) {
          return { valid: false, reason: "Rate limit exceeded" };
        }
        tracking.count++;
      } else {
        // Reset the window
        rateLimitTracking.set(rateLimitKey, {
          count: 1,
          resetAt: now + 60000,
        });
      }
    } else {
      rateLimitTracking.set(rateLimitKey, {
        count: 1,
        resetAt: now + 60000,
      });
    }
  }

  return { valid: true };
}

/**
 * Queue a forward request for approval
 */
export function queueForApproval(request: ForwardRequest): void {
  request.status = "pending";
  pendingRequests.set(request.requestId, request);

  logger.info(
    `[gateway] Request ${request.requestId} queued for approval: ` +
      `${request.sourceSession} -> ${request.targetSession}`
  );

  // Set expiration (requests expire after 5 minutes)
  setTimeout(() => {
    const req = pendingRequests.get(request.requestId);
    if (req && req.status === "pending") {
      req.status = "expired";
      pendingRequests.delete(request.requestId);
      logger.info(`[gateway] Request ${request.requestId} expired`);
    }
  }, 5 * 60 * 1000);
}

/**
 * Approve a pending forward request
 */
export function approveRequest(requestId: string): ForwardRequest | null {
  const request = pendingRequests.get(requestId);
  if (!request || request.status !== "pending") {
    return null;
  }

  request.status = "approved";
  logger.info(`[gateway] Request ${requestId} approved`);

  return request;
}

/**
 * Reject a pending forward request
 */
export function rejectRequest(
  requestId: string,
  reason: string
): ForwardRequest | null {
  const request = pendingRequests.get(requestId);
  if (!request || request.status !== "pending") {
    return null;
  }

  request.status = "rejected";
  request.rejectionReason = reason;
  pendingRequests.delete(requestId);

  logger.info(`[gateway] Request ${requestId} rejected: ${reason}`);

  return request;
}

/**
 * Complete a forward request with response
 */
export function completeRequest(
  requestId: string,
  response: string
): ForwardRequest | null {
  const request = pendingRequests.get(requestId);
  if (!request) {
    return null;
  }

  request.status = "completed";
  request.response = response;
  pendingRequests.delete(requestId);

  logger.info(`[gateway] Request ${requestId} completed`);

  return request;
}

/**
 * Get pending requests for a gateway
 */
export function getPendingRequests(gatewaySession?: string): ForwardRequest[] {
  const requests = Array.from(pendingRequests.values());

  if (gatewaySession) {
    return requests.filter((r) => r.sourceSession === gatewaySession);
  }

  return requests;
}

/**
 * Create a security context for forwarded requests
 *
 * When a gateway forwards a request, the new context:
 * - Has "gateway" source type
 * - Is semi-trusted (reduced from original trust)
 * - Carries the original requester identity
 */
export function createForwardedContext(
  request: ForwardRequest
): SecurityContext {
  const forwardedSource = createInjectionSource("gateway", {
    trustLevel: "semi-trusted",
    identity: {
      gatewaySession: request.sourceSession,
      publicKey: request.originalSource.identity?.publicKey,
    },
  });

  return createSecurityContext(forwardedSource, request.targetSession);
}

/**
 * Determine the appropriate gateway for an untrusted source
 */
export function findGatewayForSource(
  source: InjectionSource,
  requestedSession: string
): string | null {
  const config = getSecurityConfig();
  const gateways = config.gateways?.sessions ?? [];

  // Find a gateway that can forward to the requested session
  for (const gateway of gateways) {
    if (canForwardTo(gateway, requestedSession)) {
      return gateway;
    }
  }

  return null;
}

/**
 * Check if a source must go through a gateway
 */
export function requiresGateway(
  source: InjectionSource,
  targetSession: string
): boolean {
  // Owner and trusted sources don't need gateway
  if (source.trustLevel === "owner" || source.trustLevel === "trusted") {
    return false;
  }

  // Internal sources don't need gateway
  if (source.type === "internal" || source.type === "cli" || source.type === "daemon") {
    return false;
  }

  // Check if target session is a gateway (gateways don't require gateway)
  if (isGatewaySession(targetSession)) {
    return false;
  }

  // Semi-trusted and untrusted must use gateway for non-gateway targets
  return true;
}

// ============================================================================
// Helpers
// ============================================================================

function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `fwd-${timestamp}-${random}`;
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up expired requests
 */
export function cleanupExpiredRequests(): void {
  const now = Date.now();
  const expireTime = 5 * 60 * 1000; // 5 minutes

  for (const [requestId, request] of pendingRequests) {
    if (
      request.status === "pending" &&
      now - request.timestamp > expireTime
    ) {
      request.status = "expired";
      pendingRequests.delete(requestId);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredRequests, 60000);
