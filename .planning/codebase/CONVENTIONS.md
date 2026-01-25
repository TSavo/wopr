# Coding Conventions

**Analysis Date:** 2026-01-25

## Naming Patterns

**Files:**
- Lowercase with hyphens for multi-word filenames: `rate-limit.ts`, `config.ts`
- Core functionality in `src/core/`: `sessions.ts`, `cron.ts`, `registries.ts`
- Daemon routes in `src/daemon/routes/`: `sessions.ts`, `auth.ts`, `peers.ts`
- Type definitions colocated: `src/types.ts` for domain types, `src/types/hyperswarm.d.ts` for ambient types
- Example: `src/rate-limit.ts`, `src/client.ts`, `src/p2p.ts`, `src/discovery.ts`

**Functions:**
- camelCase for all functions: `getIdentity()`, `saveIdentity()`, `getAccessToken()`, `isTokenExpired()`
- verb-first pattern for utility functions: `createSession()`, `deleteSession()`, `injestPeer()`, `loadAuth()`
- adjective-first for boolean checks: `isRunning()`, `isAuthenticated()`, `isTokenExpired()`, `isBlocked()`
- Export public functions; prefix private with underscore or keep internal: `getTopic()`, `shortKey()` (public utilities)
- Example from `src/auth.ts`: `generatePKCE()`, `buildAuthUrl()`, `exchangeCode()`, `refreshAccessToken()`, `loadAuth()`

**Variables:**
- camelCase: `publicKey`, `refreshToken`, `accessToken`, `expiresAt`, `peerKey`, `sessionId`
- Boolean flags with `is` or `has` prefix: `isRunning`, `hasContext`, `isAuthenticated`, `hasOAuth`
- Constants in UPPER_SNAKE_CASE: `WOPR_HOME`, `SESSIONS_DIR`, `SKILLS_DIR`, `PROTOCOL_VERSION`
- Single letter variables only for loop indexes: `for (const i = 0; ...)`, `for (const p of peers)`
- Example from `src/cli.ts`: `const apiKey`, `const context`, `const sessions`, `const limitIndex`

**Types/Interfaces:**
- PascalCase for interfaces: `AuthState`, `Session`, `Identity`, `KeyRotation`, `P2PMessage`, `StreamMessage`
- Type suffixes: `*Entry` for log entries (`ConversationEntry`), `*Handler` for callbacks (`InjectionHandler`, `StreamHandler`)
- Discriminated unions with `type` field: `type: "oauth" | "api_key"`, `type: "text" | "tool_use" | "complete" | "error"`
- Example from `src/types.ts`: `interface AuthState`, `interface Identity`, `interface AccessGrant`, `interface DiscoveryMessage`

**Enum-like constants:**
- Type union for message types: `type P2PMessageType = "hello" | "hello-ack" | "inject" | "claim" | ...`
- Exit codes as constants: `EXIT_OK = 0`, `EXIT_OFFLINE = 1`, `EXIT_REJECTED = 2`, `EXIT_INVALID = 3`

## Code Style

**Formatting:**
- No linter or formatter configured (eslint/prettier not in package.json)
- Manual style adherence observed:
  - 2-space indentation (standard in all files)
  - Trailing semicolons on all statements
  - No trailing commas in single-line objects, commas on multi-line
  - Line length: ~100-120 characters observed (no strict enforcement)

**Linting:**
- No linter configured in package.json
- TypeScript strict mode enabled in `tsconfig.json`: `"strict": true`
- Type annotations required on exported functions and interfaces
- No unused variable tolerance (implied by code quality)

## Import Organization

**Order:**
1. Built-in Node modules (crypto, fs, path, os, etc.)
2. Third-party dependencies (hono, hyperswarm, @hono/*, etc.)
3. Local absolute imports (paths.js, types.js)
4. Local relative imports (./core/*, ./daemon/*, ./../, etc.)

**Pattern from `src/cli.ts`:**
```typescript
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

import { WOPR_HOME, SESSIONS_DIR, SKILLS_DIR, LOG_FILE, PID_FILE } from "./paths.js";
import { WoprClient } from "./client.js";
import { parseTimeSpec } from "./core/cron.js";
import { config } from "./core/config.js";
```

**Path Aliases:**
- No path aliases configured (all imports use relative paths or absolute from root)
- Consistent use of `.js` extensions in imports (ES modules)
- No barrel files (.../index.ts exports) except `src/core/index.ts` (minimal)

## Error Handling

**Patterns:**
- Throw `Error` or `new Error("message")` for critical failures: `throw new Error("Identity already exists")`
- Try-catch blocks for async operations and JSON parsing
- Error recovery: fall back to defaults if config/auth file doesn't exist
- Example from `src/auth.ts` (line 97-100):
  ```typescript
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }
  ```
- Catch blocks often don't re-throw; they return null or default values (permissive error handling)
- Example from `src/auth.ts` (line 140-158):
  ```typescript
  try {
    const data = JSON.parse(readFileSync(CLAUDE_CODE_CREDENTIALS, "utf-8"));
    // ...
  } catch {
    return null;
  }
  ```

**Exit codes (defined constants):**
- `EXIT_OK = 0` - Success
- `EXIT_OFFLINE = 1` - Peer offline
- `EXIT_REJECTED = 2` - Request rejected
- `EXIT_INVALID = 3` - Invalid input
- `EXIT_RATE_LIMITED = 4` - Rate limited
- `EXIT_VERSION_MISMATCH = 5` - Protocol version mismatch

**Error propagation in HTTP handlers:**
- Return JSON error responses: `c.json({ error: "message" }, statusCode)`
- Example from `src/daemon/routes/sessions.ts` (line 63-65):
  ```typescript
  if (!name) {
    return c.json({ error: "Name is required" }, 400);
  }
  ```

## Logging

**Framework:** console (no logging library)

**Patterns:**
- `console.log()` for info messages
- `console.error()` for errors
- `console.warn()` for warnings (not observed in code)
- No structured logging; plain text output
- Example from `src/cli.ts`:
  ```typescript
  console.error("Daemon not running. Start it: wopr daemon start");
  console.log(`Created session "${args[0]}"`);
  console.log(`Injecting into session: ${args[0]}`);
  ```
- Logging context provided via prefix: `[wopr]`, `[tool]`, `[WOPR]`

## Comments

**When to Comment:**
- JSDoc comments for public API functions
- Section headers: `// ==================== Daemon Management ====================`
- Inline comments for non-obvious logic (rarely used)
- File-level comments: Brief description of module purpose at top

**JSDoc/TSDoc:**
- Not consistently used for exported functions
- Example from `src/cli.ts` (line 3-8):
  ```typescript
  /**
   * WOPR CLI - Thin client for the WOPR daemon
   *
   * All functionality runs through the HTTP daemon. The CLI is just a thin wrapper
   * that makes HTTP calls and formats output.
   */
  ```
- Core utility functions documented: `src/auth.ts` functions have inline comments
- Type interfaces documented with property comments: `src/types.ts` has inline `//` comments
- Example from `src/types.ts` (line 32-43):
  ```typescript
  export interface AuthState {
    type: "oauth" | "api_key";
    // OAuth fields
    accessToken?: string;
    refreshToken?: string;
  ```

## Function Design

**Size:**
- Small, focused functions preferred: Most functions 10-30 lines
- Larger functions (50+ lines) exist for CLI dispatch logic: `src/cli.ts` session/skill/cron handlers
- Average utility function: 5-15 lines (e.g., `shortKey()`, `getTopic()`)

**Parameters:**
- Typed parameters required (strict mode)
- Optional parameters use `?` or default values
- Example from `src/client.ts` (line 31-32):
  ```typescript
  constructor(config: ClientConfig = {}) {
    this.baseUrl = config.baseUrl ?? DEFAULT_URL;
  }
  ```
- Destructuring for configuration objects: `const { name, context } = body`
- Spread operator for flexible collections: `...args`, `...options?.headers`

**Return Values:**
- Explicit return types on all exported functions
- Promise-based async: `async function (): Promise<T>`
- Union types for results: `Promise<{ code: number; message?: string }>`
- Example from `src/p2p.ts` (line 57-61):
  ```typescript
  async function performHandshake(
    socket: Duplex,
    myPubKey: string,
    ephemeral: EphemeralKeyPair
  ): Promise<{ version: number; peerEphemeralPub: string }>
  ```

## Module Design

**Exports:**
- Named exports preferred: `export function getIdentity()`, `export class ConfigManager`
- Default exports rarely used (only in `src/core/index.ts` for singleton config)
- Star exports not used (no re-export barrels)
- Example from `src/auth.ts`: All functions exported individually
- Example from `src/paths.ts`: All path constants exported as named exports

**Barrel Files:**
- Minimal use; `src/core/index.ts` is nearly empty
- Most files import directly from specific modules
- Pattern: `import { config } from "./core/config.js"` (not `from "./core"`

## Type System

**Strict Mode:**
- `"strict": true` enforced in `tsconfig.json`
- All function parameters and returns must be typed
- Interfaces for data structures; rarely use `any`
- Generic types used for client methods: `private async request<T>(path: string): Promise<T>`

**Type Organization:**
- Central types in `src/types.ts` (280+ lines)
- Domain-specific types grouped in interfaces
- Union discriminators for message types: `type: "hello" | "hello-ack" | ...`
- Protocol versioning tracked: `v` field in messages for migration

## Anti-Patterns to Avoid

- Don't use `any` type (strict mode prevents this)
- Don't omit return type annotations on public functions
- Don't mix relative and absolute imports inconsistently
- Don't create barrel files without need
- Don't mix camelCase and snake_case in same scope
- Don't log to console without context prefix
- Don't catch errors and silently continue (unless intentional, like optional config loading)
- Don't export implementation details (functions use module-private state)

---

*Convention analysis: 2026-01-25*
