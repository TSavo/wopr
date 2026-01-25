/**
 * WOPR OAuth Authentication
 *
 * Supports:
 * - Claude Max/Pro OAuth (subscription-based, no per-token cost)
 * - API Key (pay-per-use)
 */

import { randomBytes, createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { AUTH_FILE } from "./paths.js";

// Claude Code credentials location
const CLAUDE_CODE_CREDENTIALS = join(homedir(), ".claude", ".credentials.json");

// Anthropic OAuth configuration
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTH_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const OAUTH_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];

// Required beta headers for Claude Code
const BETA_HEADERS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
];

export interface AuthState {
  type: "oauth" | "api_key";
  // OAuth fields
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  // API key field
  apiKey?: string;
  // Metadata
  email?: string;
  updatedAt: number;
}

export interface PKCEChallenge {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

// Generate PKCE challenge for OAuth
export function generatePKCE(): PKCEChallenge {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { state, codeVerifier, codeChallenge };
}

// Build the OAuth authorization URL
export function buildAuthUrl(pkce: PKCEChallenge, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
  });

  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

// Exchange authorization code for tokens
export async function exchangeCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
  };
}

// Refresh an expired access token
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
  };
}

// Load Claude Code credentials if available
export function loadClaudeCodeCredentials(): AuthState | null {
  if (!existsSync(CLAUDE_CODE_CREDENTIALS)) return null;
  try {
    const data = JSON.parse(readFileSync(CLAUDE_CODE_CREDENTIALS, "utf-8"));
    const oauth = data.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        type: "oauth",
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
        email: oauth.email,
        updatedAt: Date.now(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Load auth state from disk (checks Claude Code creds first, then WOPR's own)
export function loadAuth(): AuthState | null {
  // First check for Claude Code credentials
  const claudeCodeAuth = loadClaudeCodeCredentials();
  if (claudeCodeAuth) return claudeCodeAuth;

  // Fall back to WOPR's own auth file
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// Save auth state to disk
export function saveAuth(auth: AuthState): void {
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

// Clear auth state
export function clearAuth(): void {
  if (existsSync(AUTH_FILE)) {
    writeFileSync(AUTH_FILE, "{}");
  }
}

// Check if token is expired (with 5 min buffer)
export function isTokenExpired(auth: AuthState): boolean {
  if (!auth.expiresAt) return true;
  return Date.now() > auth.expiresAt - 5 * 60 * 1000;
}

// Get valid access token, refreshing if needed
export async function getAccessToken(): Promise<string | null> {
  const auth = loadAuth();
  if (!auth) return null;

  // API key mode - just return it
  if (auth.type === "api_key" && auth.apiKey) {
    return auth.apiKey;
  }

  // OAuth mode
  if (auth.type === "oauth" && auth.accessToken) {
    // Check if expired
    if (isTokenExpired(auth) && auth.refreshToken) {
      try {
        const tokens = await refreshAccessToken(auth.refreshToken);
        auth.accessToken = tokens.accessToken;
        auth.refreshToken = tokens.refreshToken;
        auth.expiresAt = Date.now() + tokens.expiresIn * 1000;
        auth.updatedAt = Date.now();
        saveAuth(auth);
      } catch (err) {
        console.error("Failed to refresh token:", err);
        return null;
      }
    }
    return auth.accessToken;
  }

  return null;
}

// Get auth type
export function getAuthType(): "oauth" | "api_key" | null {
  const auth = loadAuth();
  return auth?.type || null;
}

// Check if authenticated
export function isAuthenticated(): boolean {
  const auth = loadAuth();
  if (!auth) return false;
  if (auth.type === "api_key") return !!auth.apiKey;
  if (auth.type === "oauth") return !!auth.accessToken;
  return false;
}

// Get beta headers for OAuth requests
export function getBetaHeaders(): string {
  return BETA_HEADERS.join(",");
}

// Save OAuth tokens after successful auth flow
export function saveOAuthTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  email?: string
): void {
  const auth: AuthState = {
    type: "oauth",
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    email,
    updatedAt: Date.now(),
  };
  saveAuth(auth);
}

// Save API key
export function saveApiKey(apiKey: string): void {
  const auth: AuthState = {
    type: "api_key",
    apiKey,
    updatedAt: Date.now(),
  };
  saveAuth(auth);
}
