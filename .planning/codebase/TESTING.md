# Testing Patterns

**Analysis Date:** 2026-01-25

## Test Framework

**Status:** No testing framework configured

**Runner:** Not applicable
- No `jest`, `vitest`, `mocha`, or other test runner in `package.json`
- No test files found in project source (`src/`, excluding node_modules)
- No test configuration files (`jest.config.*`, `vitest.config.*`)

**Assertion Library:** Not applicable

**Scripts:** No test scripts defined in `package.json`
- `package.json` contains only: `"build": "tsc"`, `"dev": "tsx src/cli.ts"`, `"daemon": "tsx src/daemon/index.ts"`
- No `"test"`, `"test:watch"`, or `"test:coverage"` scripts

## Test File Organization

**Location:** No test files exist in project

**Naming Convention:** Would follow pattern `*.test.ts` or `*.spec.ts` if created
- Based on npm ecosystem conventions observed in node_modules

**Structure:** Would be co-located with source
- Likely: `src/core/sessions.test.ts` alongside `src/core/sessions.ts`
- Likely: `src/cli.test.ts` for CLI logic
- Router tests would go in: `src/daemon/routes/*.test.ts`

## Testing Gap Analysis

**Critical untested areas:**

1. **Authentication (src/auth.ts)**
   - OAuth flow: `generatePKCE()`, `buildAuthUrl()`, `exchangeCode()`, `refreshAccessToken()`
   - Token refresh logic with expiration
   - Credential loading from Claude Code and WOPR auth files
   - File I/O for auth state persistence
   - Risk: High - authentication failures would break entire CLI

2. **P2P Encryption & Handshake (src/p2p.ts)**
   - Version negotiation: `performHandshake()`
   - Message encryption/decryption: `encryptMessage()`, `decryptMessage()`
   - Forward secrecy with ephemeral keys
   - Signature verification
   - Risk: High - security issues could lead to message tampering or replay attacks

3. **Session Management (src/core/sessions.ts)**
   - Session creation, injection, deletion
   - Conversation log reading/writing
   - Context persistence
   - File-based storage reliability
   - Risk: High - data loss if storage fails

4. **Cron Job Scheduling (src/core/cron.ts)**
   - Time spec parsing: `parseTimeSpec()`
   - Cron schedule evaluation
   - Job execution triggering
   - Risk: Medium - scheduled tasks might not execute

5. **Configuration Management (src/core/config.ts)**
   - Config loading from file with merge logic
   - Deep key access/setting: `getValue()`, `setValue()`
   - Config persistence
   - Risk: Medium - config corruption could disable daemon

6. **Rate Limiting (src/rate-limit.ts)**
   - Rate limit checking: `check()` method
   - Block state tracking
   - Window cleanup
   - Risk: Medium - attackers could bypass rate limits

7. **Identity Management (src/identity.ts)**
   - Key generation: `initIdentity()`, `rotateIdentity()`
   - Key rotation message generation
   - Identity persistence
   - Risk: High - key loss would break peer relationships

8. **CLI Command Parsing (src/cli.ts)**
   - All 15+ command handlers (session, skill, cron, config, daemon, auth, id, invite, access, revoke, peers, inject, plugin, discover, init)
   - Flag parsing (--limit, --now, --once, --broadcast, --force)
   - Argument validation
   - Risk: High - command failures could prevent user interaction

9. **Daemon HTTP Routes (src/daemon/routes/*.ts)**
   - Session endpoints: GET/POST/PUT/DELETE
   - Auth endpoints
   - Skills endpoints
   - Plugin endpoints
   - Discovery endpoints
   - Risk: High - API failures would break entire daemon

10. **WebSocket Streaming (src/daemon/ws.ts)**
    - Stream setup and message handling
    - Client subscription/unsubscription
    - Risk: High - real-time updates would fail

## How Testing Would Be Structured

**If tests were added, recommended patterns:**

### Unit Tests

**Authentication tests (`src/auth.test.ts`):**
```typescript
// Would test individual functions
describe("PKCE", () => {
  it("generatePKCE returns state, verifier, and challenge", () => {
    const pkce = generatePKCE();
    expect(pkce.state).toBeDefined();
    expect(pkce.codeVerifier).toBeDefined();
    expect(pkce.codeChallenge).toBeDefined();
  });

  it("code challenge is SHA256 hash of verifier", () => {
    // Verify cryptographic properties
  });
});

describe("Token expiration", () => {
  it("isTokenExpired returns true when expiration passed", () => {
    const auth: AuthState = {
      type: "oauth",
      expiresAt: Date.now() - 1000,
      updatedAt: Date.now()
    };
    expect(isTokenExpired(auth)).toBe(true);
  });

  it("isTokenExpired adds 5 minute buffer", () => {
    const auth: AuthState = {
      type: "oauth",
      expiresAt: Date.now() + 2 * 60 * 1000, // expires in 2 min
      updatedAt: Date.now()
    };
    expect(isTokenExpired(auth)).toBe(true); // 5 min buffer
  });
});
```

**Configuration tests (`src/core/config.test.ts`):**
```typescript
describe("ConfigManager", () => {
  it("getValue with dot notation accesses nested properties", () => {
    const config = new ConfigManager();
    config.setValue("daemon.port", 7437);
    expect(config.getValue("daemon.port")).toBe(7437);
  });

  it("setValue creates nested objects as needed", () => {
    const config = new ConfigManager();
    config.setValue("new.deep.key", "value");
    expect(config.getValue("new.deep.key")).toBe("value");
  });

  it("merge combines defaults with overrides", () => {
    // Test deep merge behavior
  });
});
```

**Rate limiting tests (`src/rate-limit.test.ts`):**
```typescript
describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const limiter = new RateLimiter();
    expect(limiter.check("peer1", "injects")).toBe(true);
    expect(limiter.check("peer1", "injects")).toBe(true);
  });

  it("blocks after exceeding limit", () => {
    const limiter = new RateLimiter({
      injects: { windowMs: 1000, maxRequests: 2, blockDurationMs: 1000 }
    });
    limiter.check("peer1", "injects");
    limiter.check("peer1", "injects");
    expect(limiter.check("peer1", "injects")).toBe(false);
  });

  it("resets state after window expires", () => {
    // Test time-based state cleanup
  });
});
```

### Integration Tests

**Session management tests (`src/core/sessions.test.ts`):**
```typescript
describe("Session lifecycle", () => {
  // Would use temp file system
  beforeEach(() => {
    // Set up temp WOPR_HOME
  });

  afterEach(() => {
    // Clean up temp files
  });

  it("creates and retrieves session", () => {
    setSessionContext("test-session", "You are helpful");
    const context = getSessionContext("test-session");
    expect(context).toBe("You are helpful");
  });

  it("persists conversation log", () => {
    inject("test-session", "hello", false);
    const history = readConversationLog("test-session");
    expect(history.length).toBeGreaterThan(0);
  });
});
```

**CLI integration tests (`src/cli.test.ts`):**
```typescript
describe("CLI commands", () => {
  // Would need to mock HTTP client
  it("session create calls daemon API", async () => {
    const client = new WoprClient();
    jest.spyOn(client, "createSession").mockResolvedValueOnce(undefined);

    await client.createSession("test", "context");
    expect(client.createSession).toHaveBeenCalledWith("test", "context");
  });
});
```

### Mocking Strategy (if implemented)

**What would need mocking:**
- Network calls (fetch for OAuth, daemon HTTP)
- File I/O (fs.readFileSync, writeFileSync for config/auth)
- Crypto operations (for signature verification testing)
- WebSocket connections
- Process operations (execSync for daemon start)

**Mock library:** Would use `jest` or similar built-in mocking

Example approach:
```typescript
jest.mock("fs");
jest.mock("node:crypto");

const mockFetch = jest.fn();
global.fetch = mockFetch;
```

### Test Data Fixtures

**No fixtures currently exist**, but patterns would be:

`tests/fixtures/auth-tokens.ts`:
```typescript
export const validAccessToken = "eyJhbGc...";
export const expiredAccessToken = "eyJhbGc...";
export const validRefreshToken = "refresh_...";

export const mockAuthState: AuthState = {
  type: "oauth",
  accessToken: validAccessToken,
  refreshToken: validRefreshToken,
  expiresAt: Date.now() + 3600 * 1000,
  updatedAt: Date.now()
};
```

`tests/fixtures/identities.ts`:
```typescript
export const mockIdentity: Identity = {
  publicKey: "base64encodedpublickey",
  privateKey: "base64encodedprivatekey",
  encryptPub: "base64encryptpub",
  encryptPriv: "base64encryptpriv",
  created: Date.now()
};
```

## Coverage Gaps Summary

**Current coverage:** 0% (no tests)

**Priority areas for testing:**

| Component | Criticality | Complexity | Recommended First |
|-----------|-------------|------------|------------------|
| Authentication | High | Medium | Yes |
| P2P Encryption | High | High | Yes |
| Session Management | High | Medium | Yes |
| Configuration | Medium | Low | Yes |
| Rate Limiting | Medium | Low | After core |
| Identity Management | High | High | Yes |
| Cron Scheduling | Medium | Medium | After core |
| CLI Commands | High | High | After core |
| Daemon Routes | High | Medium | After core |
| WebSocket | High | High | After core |

## Recommended Testing Approach

**Phase 1 (Core Security):**
- Authentication flow testing (OAuth, token refresh, file persistence)
- P2P encryption and signature verification
- Identity generation and rotation

**Phase 2 (Data Integrity):**
- Session creation/deletion/persistence
- Configuration management (load, merge, save)
- Conversation log reading/writing

**Phase 3 (API & Integration):**
- All daemon HTTP route handlers
- CLI command parsing and execution
- WebSocket streaming

**Phase 4 (Performance & Edge Cases):**
- Rate limiting under load
- Concurrent session handling
- Large message handling

**Test Framework Recommendation:** Jest or Vitest
- Both support TypeScript natively
- Jest has better ecosystem maturity
- Vitest is faster and more modern

---

*Testing analysis: 2026-01-25*
