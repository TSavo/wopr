/**
 * WOPR Security Hooks
 *
 * Composable hook system for injection lifecycle.
 * Hooks can transform messages, add metadata, log, or block injections.
 */

import { spawn } from "child_process";
import { logger } from "../logger.js";
import {
  type InjectionSource,
  type HookConfig,
  type SecurityConfig,
} from "./types.js";
import { getSecurityConfig } from "./policy.js";

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Context passed to hooks
 */
export interface HookContext {
  /** The message being injected */
  message: string;

  /** Source of the injection */
  source: InjectionSource;

  /** Target session */
  targetSession: string;

  /** Timestamp */
  timestamp: number;

  /** Additional metadata (hooks can add to this) */
  metadata: Record<string, unknown>;
}

/**
 * Result from a pre-inject hook
 */
export interface PreInjectResult {
  /** Whether to allow the injection */
  allow: boolean;

  /** Reason if blocked */
  reason?: string;

  /** Transformed message (if modified) */
  message?: string;

  /** Additional metadata to attach */
  metadata?: Record<string, unknown>;
}

/**
 * Result from a post-inject hook
 */
export interface PostInjectResult {
  /** Any data to log or store */
  data?: Record<string, unknown>;
}

// ============================================================================
// Hook Execution
// ============================================================================

/**
 * Run a shell command hook
 */
async function runCommandHook(
  command: string,
  context: HookContext
): Promise<PreInjectResult | PostInjectResult> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    // Send context as JSON to stdin
    proc.stdin.write(JSON.stringify(context));
    proc.stdin.end();

    proc.on("close", (code) => {
      if (code !== 0) {
        logger.warn(`[hooks] Hook command failed: ${stderr}`);
        resolve({ allow: true }); // Allow by default on hook failure
        return;
      }

      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch {
        logger.warn(`[hooks] Hook returned invalid JSON: ${stdout}`);
        resolve({ allow: true });
      }
    });

    proc.on("error", (err) => {
      logger.warn(`[hooks] Hook command error: ${err.message}`);
      resolve({ allow: true });
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      proc.kill();
      logger.warn("[hooks] Hook timed out");
      resolve({ allow: true });
    }, 5000);
  });
}

/**
 * Run all pre-inject hooks
 */
export async function runPreInjectHooks(
  context: HookContext
): Promise<PreInjectResult> {
  const config = getSecurityConfig();
  const hooks = config.hooks?.filter(
    (h) => h.type === "pre-inject" && h.enabled
  ) || [];

  let currentMessage = context.message;
  let metadata: Record<string, unknown> = { ...context.metadata };

  for (const hook of hooks) {
    const hookContext = { ...context, message: currentMessage, metadata };

    if (hook.command) {
      const result = await runCommandHook(hook.command, hookContext) as PreInjectResult;

      if (result.allow === false) {
        return {
          allow: false,
          reason: result.reason || `Blocked by hook: ${hook.name}`,
        };
      }

      if (result.message) {
        currentMessage = result.message;
      }

      if (result.metadata) {
        metadata = { ...metadata, ...result.metadata };
      }
    }
  }

  return {
    allow: true,
    message: currentMessage,
    metadata,
  };
}

/**
 * Run all post-inject hooks
 */
export async function runPostInjectHooks(
  context: HookContext,
  response: string
): Promise<void> {
  const config = getSecurityConfig();
  const hooks = config.hooks?.filter(
    (h) => h.type === "post-inject" && h.enabled
  ) || [];

  const postContext = {
    ...context,
    response,
  };

  for (const hook of hooks) {
    if (hook.command) {
      try {
        await runCommandHook(hook.command, postContext as unknown as HookContext);
      } catch (err) {
        logger.warn(`[hooks] Post-inject hook ${hook.name} failed: ${err}`);
      }
    }
  }
}

// ============================================================================
// Built-in Hooks
// ============================================================================

/**
 * Built-in hook: Add source metadata to message
 */
export function addSourceMetadata(context: HookContext): PreInjectResult {
  const { source, message } = context;

  const metadataHeader = `[From: ${source.identity?.gatewaySession || source.identity?.publicKey || source.type} | Trust: ${source.trustLevel}]`;

  return {
    allow: true,
    message: `${metadataHeader}\n\n${message}`,
    metadata: {
      sourceTagged: true,
      sourceType: source.type,
      sourceTrust: source.trustLevel,
    },
  };
}

/**
 * Built-in hook: Log injection for audit
 */
export function auditLogHook(
  context: HookContext,
  allowed: boolean,
  reason?: string
): void {
  const config = getSecurityConfig();

  if (!config.audit?.enabled) return;
  if (allowed && !config.audit.logSuccess) return;
  if (!allowed && !config.audit.logDenied) return;

  const logEntry = {
    timestamp: new Date().toISOString(),
    type: "injection",
    allowed,
    reason,
    source: {
      type: context.source.type,
      trustLevel: context.source.trustLevel,
      identity: context.source.identity,
    },
    target: context.targetSession,
    messageLength: context.message.length,
  };

  // Log to configured path or stdout
  if (config.audit.logPath) {
    // Would append to file - for now just log
    logger.info(`[audit] ${JSON.stringify(logEntry)}`);
  } else {
    logger.info(`[audit] ${JSON.stringify(logEntry)}`);
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a hook context from injection parameters
 */
export function createHookContext(
  message: string,
  source: InjectionSource,
  targetSession: string
): HookContext {
  return {
    message,
    source,
    targetSession,
    timestamp: Date.now(),
    metadata: {},
  };
}

/**
 * Process an injection through the hook pipeline
 */
export async function processInjection(
  message: string,
  source: InjectionSource,
  targetSession: string,
  options?: {
    addMetadata?: boolean;
  }
): Promise<{ allowed: boolean; message: string; reason?: string }> {
  const context = createHookContext(message, source, targetSession);

  // Optionally add source metadata
  let processedMessage = message;
  if (options?.addMetadata) {
    const metaResult = addSourceMetadata(context);
    processedMessage = metaResult.message || message;
    context.message = processedMessage;
  }

  // Run pre-inject hooks
  const preResult = await runPreInjectHooks(context);

  // Audit log
  auditLogHook(context, preResult.allow, preResult.reason);

  if (!preResult.allow) {
    return {
      allowed: false,
      message: message,
      reason: preResult.reason,
    };
  }

  return {
    allowed: true,
    message: preResult.message || processedMessage,
  };
}
