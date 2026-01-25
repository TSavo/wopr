/**
 * Auth API routes
 */

import { Hono } from "hono";
import {
  loadAuth,
  loadClaudeCodeCredentials,
  saveApiKey,
  clearAuth,
  isAuthenticated,
  getAuthType,
  generatePKCE,
  buildAuthUrl,
  exchangeCode,
  saveOAuthTokens,
} from "../../auth.js";

export const authRouter = new Hono();

// Get auth status
authRouter.get("/", (c) => {
  const claudeCodeAuth = loadClaudeCodeCredentials();
  const auth = loadAuth();

  if (claudeCodeAuth) {
    return c.json({
      authenticated: true,
      type: "oauth",
      source: "claude-code",
      email: claudeCodeAuth.email || null,
      expiresAt: claudeCodeAuth.expiresAt || null,
    });
  }

  if (!auth || (!auth.apiKey && !auth.accessToken)) {
    return c.json({
      authenticated: false,
    });
  }

  if (auth.type === "oauth") {
    return c.json({
      authenticated: true,
      type: "oauth",
      source: "wopr",
      email: auth.email || null,
      expiresAt: auth.expiresAt || null,
    });
  }

  if (auth.type === "api_key") {
    return c.json({
      authenticated: true,
      type: "api_key",
      keyPrefix: auth.apiKey?.substring(0, 12) + "...",
    });
  }

  return c.json({ authenticated: false });
});

// Start OAuth flow - returns URL to redirect to
authRouter.post("/login", (c) => {
  const pkce = generatePKCE();
  const redirectUri = "http://localhost:9876/callback";
  const authUrl = buildAuthUrl(pkce, redirectUri);

  // Store PKCE challenge in a temp way (in production, use session)
  // For now, we return it and expect the client to handle it
  return c.json({
    authUrl,
    redirectUri,
    state: pkce.state,
    codeVerifier: pkce.codeVerifier,
  });
});

// Complete OAuth flow
authRouter.post("/callback", async (c) => {
  const body = await c.req.json();
  const { code, codeVerifier, redirectUri } = body;

  if (!code || !codeVerifier || !redirectUri) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  try {
    const tokens = await exchangeCode(code, codeVerifier, redirectUri);
    saveOAuthTokens(tokens.accessToken, tokens.refreshToken, tokens.expiresIn);

    return c.json({
      success: true,
      expiresIn: tokens.expiresIn,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Set API key
authRouter.post("/api-key", async (c) => {
  const body = await c.req.json();
  const { apiKey } = body;

  if (!apiKey) {
    return c.json({ error: "API key is required" }, 400);
  }

  saveApiKey(apiKey);
  return c.json({ success: true });
});

// Logout
authRouter.post("/logout", (c) => {
  clearAuth();
  return c.json({ success: true });
});
