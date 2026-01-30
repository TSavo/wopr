/**
 * WOPR Security Forward - Cross-Session Forwarding with Policy
 *
 * Handles the actual forwarding of requests from gateway sessions
 * to privileged sessions, with full policy enforcement.
 */

import { logger } from "../logger.js";
import {
  type InjectionSource,
  createInjectionSource,
} from "./types.js";
import {
  SecurityContext,
  createSecurityContext,
  storeContext,
  clearContext,
} from "./context.js";
import {
  isGateway,
  getForwardRules,
  canForwardTo,
  createForwardRequest,
  validateForwardRequest,
  queueForApproval,
  approveRequest,
  completeRequest,
  createForwardedContext,
  requiresGateway,
  findGatewayForSource,
  type ForwardRequest,
  type GatewayForwardRules,
} from "./gateway.js";

// ============================================================================
// Forward Result
// ============================================================================

export interface ForwardResult {
  /** Whether the forward was successful */
  success: boolean;

  /** Response from target session (if successful) */
  response?: string;

  /** Error message (if failed) */
  error?: string;

  /** Request ID for tracking */
  requestId: string;

  /** Whether request requires approval */
  requiresApproval?: boolean;
}

// ============================================================================
// Forward Functions
// ============================================================================

/**
 * Forward a request through a gateway to a target session
 *
 * This is the main entry point for gateway forwarding.
 * It handles:
 * 1. Validating the gateway has permission to forward
 * 2. Checking rate limits
 * 3. Queuing for approval if required
 * 4. Creating the forwarded security context
 * 5. Executing the forward
 */
export async function forwardRequest(
  gatewaySession: string,
  targetSession: string,
  message: string,
  originalSource: InjectionSource,
  options?: {
    actionType?: string;
    skipApproval?: boolean;
    injectFn?: (
      session: string,
      message: string,
      options?: { source?: InjectionSource; silent?: boolean }
    ) => Promise<{ response: string }>;
  }
): Promise<ForwardResult> {
  // Get gateway context
  const gatewayContext = createSecurityContext(
    createInjectionSource("internal", {
      trustLevel: "owner",
      identity: { gatewaySession },
    }),
    gatewaySession
  );

  // Verify this is a gateway session
  if (!isGateway(gatewaySession)) {
    return {
      success: false,
      error: `Session ${gatewaySession} is not a gateway`,
      requestId: "",
    };
  }

  // Create forward request
  const request = createForwardRequest(
    gatewaySession,
    targetSession,
    message,
    originalSource,
    options?.actionType
  );

  // Validate request
  const validation = validateForwardRequest(request, gatewayContext);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.reason,
      requestId: request.requestId,
    };
  }

  // Check if approval is required
  const rules = getForwardRules(gatewaySession);
  if (rules?.requireApproval && !options?.skipApproval) {
    queueForApproval(request);
    return {
      success: false,
      requiresApproval: true,
      error: "Request queued for approval",
      requestId: request.requestId,
    };
  }

  // Execute the forward
  return executeForward(request, options?.injectFn);
}

/**
 * Execute a validated forward request
 */
export async function executeForward(
  request: ForwardRequest,
  injectFn?: (
    session: string,
    message: string,
    options?: { source?: InjectionSource; silent?: boolean }
  ) => Promise<{ response: string }>
): Promise<ForwardResult> {
  // Create forwarded context
  const forwardedContext = createForwardedContext(request);

  logger.info(
    `[forward] Executing forward ${request.requestId}: ` +
      `${request.sourceSession} -> ${request.targetSession}`
  );

  try {
    // If no inject function provided, we can't actually forward
    if (!injectFn) {
      return {
        success: false,
        error: "No inject function provided",
        requestId: request.requestId,
      };
    }

    // Execute injection with forwarded context
    storeContext(forwardedContext);
    try {
      const result = await injectFn(request.targetSession, request.message, {
        source: forwardedContext.source,
        silent: true,
      });

      // Complete the request
      completeRequest(request.requestId, result.response);

      return {
        success: true,
        response: result.response,
        requestId: request.requestId,
      };
    } finally {
      clearContext(request.targetSession);
    }
  } catch (err: any) {
    logger.error(
      `[forward] Forward ${request.requestId} failed: ${err.message}`
    );
    return {
      success: false,
      error: err.message,
      requestId: request.requestId,
    };
  }
}

/**
 * Approve and execute a pending forward request
 */
export async function approveAndExecute(
  requestId: string,
  injectFn?: (
    session: string,
    message: string,
    options?: { source?: InjectionSource; silent?: boolean }
  ) => Promise<{ response: string }>
): Promise<ForwardResult> {
  const request = approveRequest(requestId);
  if (!request) {
    return {
      success: false,
      error: "Request not found or not pending",
      requestId,
    };
  }

  return executeForward(request, injectFn);
}

/**
 * Route an untrusted injection through the appropriate gateway
 *
 * This is called when an untrusted source tries to inject into a
 * privileged session directly. Instead of rejecting, we route
 * through a gateway if one is available.
 */
export async function routeThroughGateway(
  source: InjectionSource,
  targetSession: string,
  message: string,
  injectFn?: (
    session: string,
    message: string,
    options?: { source?: InjectionSource; silent?: boolean }
  ) => Promise<{ response: string }>
): Promise<ForwardResult | null> {
  // Check if this source requires a gateway
  if (!requiresGateway(source, targetSession)) {
    return null; // Direct access allowed
  }

  // Find an appropriate gateway
  const gateway = findGatewayForSource(source, targetSession);
  if (!gateway) {
    return {
      success: false,
      error: "No gateway available for this request",
      requestId: "",
    };
  }

  logger.info(
    `[forward] Routing through gateway ${gateway} for ${source.type} -> ${targetSession}`
  );

  // Forward through the gateway
  return forwardRequest(gateway, targetSession, message, source, {
    injectFn,
  });
}

/**
 * Handle a gateway tool call (from A2A MCP)
 *
 * This is exposed as the gateway_forward tool for gateway sessions.
 */
export async function handleGatewayForward(
  gatewaySession: string,
  targetSession: string,
  message: string,
  gatewayContext: SecurityContext,
  injectFn?: (
    session: string,
    message: string,
    options?: { source?: InjectionSource; silent?: boolean }
  ) => Promise<{ response: string }>
): Promise<ForwardResult> {
  // Verify caller is the gateway
  if (gatewayContext.session !== gatewaySession) {
    return {
      success: false,
      error: "Context mismatch",
      requestId: "",
    };
  }

  // Create a synthetic source representing the gateway itself
  const gatewaySource = createInjectionSource("gateway", {
    trustLevel: gatewayContext.trustLevel,
    identity: { gatewaySession },
  });

  return forwardRequest(gatewaySession, targetSession, message, gatewaySource, {
    injectFn,
  });
}

// ============================================================================
// Gateway A2A Tools (to be registered)
// ============================================================================

/**
 * Tool definitions for gateway-specific A2A tools
 *
 * These are registered by gateway sessions to expose forwarding
 * capabilities to their agents.
 */
export const gatewayToolDefinitions = {
  gateway_forward: {
    name: "gateway_forward",
    description:
      "Forward a request to another session. Only available in gateway sessions.",
    schema: {
      target: "string - Target session name",
      message: "string - Message to forward",
    },
  },

  gateway_queue: {
    name: "gateway_queue",
    description: "View pending requests awaiting approval.",
    schema: {},
  },

  gateway_approve: {
    name: "gateway_approve",
    description: "Approve a pending forward request.",
    schema: {
      requestId: "string - Request ID to approve",
    },
  },

  gateway_reject: {
    name: "gateway_reject",
    description: "Reject a pending forward request.",
    schema: {
      requestId: "string - Request ID to reject",
      reason: "string - Rejection reason",
    },
  },
};
