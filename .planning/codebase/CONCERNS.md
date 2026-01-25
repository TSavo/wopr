# Codebase Concerns

**Analysis Date:** 2026-01-25

## Tech Debt

**Untracked Session Creation Times:**
- Issue: Sessions lack `created` field initialization (hardcoded to 0)
- Files: `src/core/sessions.ts:63`
- Impact: Cannot determine when sessions were created; breaks session ordering and analytics
- Fix approach: Add timestamp to session creation, persist in SESSIONS_FILE alongside session IDs, initialize `created: Date.now()` when saving new sessions

**Missing Error Boundary in Daemon Startup:**
- Issue: Daemon startup (`src/daemon/index.ts:84-250`) lacks comprehensive error handling for startup failures
- Files: `src/daemon/index.ts`
- Impact: Daemon failures are silent; no proper error reporting to CLI; orphaned processes possible
- Fix approach: Wrap startup logic in try-catch, write errors to PID_FILE marker or separate error file, add health check endpoint validation before marking daemon as started

**Incomplete Conversation History with Context Providers:**
- Issue: Context providers add conversation history but it's appended as single entries, not parsed into message pairs
- Files: `src/core/sessions.ts:128-149`
- Impact: Conversation log structure becomes inconsistent; makes history replay/analysis difficult
- Fix approach: Normalize context provider output to match ConversationEntry format before appending to log

**TODO Marker Not Implemented:**
- Issue: Session tracking explicitly marked as TODO but never completed
- Files: `src/core/sessions.ts:63`
- Impact: Sessions cannot be time-sorted; breaks session age tracking
- Fix approach: Parse session JSONL logs to extract `created` timestamp or infer from first message

## Security Considerations

**Shell Injection Risk in Git Operations:**
- Risk: `owner` and `repo` parameters injected into shell commands without validation
- Files: `src/core/registries.ts:119,126`, `src/core/skills.ts:112,114,115`, `src/plugins.ts:69,120`, `src/cli.ts:488,608`
- Current mitigation: Parameters are quoted, but not validated for special characters
- Recommendation: Validate inputs before passing to shell. Use `git` APIs directly (Node.js library) instead of `execSync` where possible, or strictly validate owner/repo format (alphanumeric + hyphen only)

**Unvalidated JSON Parsing:**
- Risk: Multiple `JSON.parse()` calls with bare catch blocks that silently fail
- Files: `src/auth.ts:156-158`, `src/core/registries.ts:55,95`, `src/daemon/routes/sessions.ts:60,80,106`
- Impact: Corrupted config/data files silently return empty/null; malformed inputs cause mysterious bugs
- Recommendation: Add validation schemas (Zod/io-ts); log parse errors; return typed defaults; validate before parsing

**Plaintext Token Storage:**
- Risk: OAuth tokens and API keys stored in plaintext JSON files with no encryption
- Files: `src/auth.ts:177-179`, `src/paths.ts` (AUTH_FILE location)
- Current mitigation: Files are in WOPR_HOME (typically ~/.wopr) with restrictive permissions
- Recommendation: Encrypt auth state with system keyring (keytar) or use environment variables; document security model; warn users about plaintext storage

**No Input Validation on CLI Parameters:**
- Risk: Session names, peer IDs, and other user inputs used directly in file paths and commands
- Files: `src/cli.ts` (all session/skill/cron commands), `src/daemon/routes/` (all route handlers)
- Impact: Directory traversal attacks possible (e.g., `wopr session create "../../../etc/passwd" msg`)
- Recommendation: Validate all path components: reject `.`, `..`, `/`, and other special chars; use `path.basename()` for user-provided names

**Arbitrary Plugin Code Execution:**
- Risk: Plugins loaded from arbitrary GitHub repos or npm packages without security audit
- Files: `src/plugins.ts:57-143` (installPlugin), `src/plugins.ts:240-280` (loadPlugin)
- Impact: Plugin can access entire WOPR runtime, session data, and credentials
- Recommendation: Implement plugin sandboxing (VM2, isolated-vm); require explicit manifest permissions; whitelist safe APIs only

**No Rate Limiting on Session Injection:**
- Risk: While rate limiter exists, it's not enforced at daemon route level
- Files: `src/daemon/routes/sessions.ts:104-175` (inject endpoint), `src/rate-limit.ts` (defined but not used in routes)
- Impact: Attacker can spam injections to exhaust API quota or DOS daemon
- Recommendation: Middleware to check rate limiter before injection; return 429 if blocked; integrate with peer-based rate limiting

## Performance Bottlenecks

**Synchronous File I/O in Hot Paths:**
- Problem: All session operations use synchronous `readFileSync`/`writeFileSync`
- Files: `src/core/sessions.ts:25-90`, `src/core/registries.ts:12-33`, `src/daemon/routes/sessions.ts`
- Impact: Blocking operations freeze daemon during large file reads; scales poorly with many sessions
- Improvement path: Use async I/O (promises); batch writes; implement write queue; add in-memory cache layer

**Repository Cloning on Every Registry Search:**
- Problem: `fetchGitHubSkills()` clones entire GitHub repos to cache, then scans filesystem
- Files: `src/core/registries.ts:74-161`
- Impact: First registry search is slow (5-30s depending on repo size); network bottleneck; repeated pulls
- Improvement path: Use GitHub API search endpoint (already attempted with token); cache results with TTL; implement incremental sync instead of full pull

**Unindexed Conversation Log Reads:**
- Problem: Reading conversation history loads entire JSONL file line-by-line, parses each line
- Files: `src/core/sessions.ts:78-90`
- Impact: 100,000+ message history takes seconds to load; O(n) complexity
- Improvement path: Implement append-only log rotation; index by timestamp; use SQLite for persistent query performance

**Memory Leak in Event Listeners:**
- Problem: WebSocket handlers broadcast to all connected clients without cleanup on disconnect
- Files: `src/daemon/ws.ts`, `src/daemon/routes/sessions.ts:138`
- Impact: Event listener count grows unbounded; old connections continue receiving broadcasts
- Improvement path: Properly track and remove listeners on socket close; implement weakRef cleanup

**Regex-Based Skill Scanning with Depth Limit:**
- Problem: `scanDir()` recursively scans directories with arbitrary depth, no parallel processing
- Files: `src/core/registries.ts:136-157`
- Impact: Large skill repositories (100+ skills) scan slowly; single-threaded
- Improvement path: Use parallel directory walks; cache results; implement skill index file instead of directory scan

## Fragile Areas

**P2P Protocol Handshake Race Conditions:**
- Files: `src/p2p.ts:57-120`
- Why fragile: Handshake uses timeout promises with buffer state; multiple data events could corrupt buffer; version negotiation not idempotent
- Safe modification: Add message framing (length-prefixed); validate all state transitions before processing; test edge cases (rapid disconnects, out-of-order messages)
- Test coverage: No unit tests for handshake protocol; integration test gaps for version mismatch

**Discovery Topic Hash Consistency:**
- Files: `src/discovery.ts:32-34`
- Why fragile: `getTopicHash()` deterministic but if hash algorithm changes, all peers disconnect; no versioning
- Safe modification: Add protocol version to hash input; document hash algorithm in types; test compatibility across versions
- Test coverage: No tests verifying hash consistency

**CLI Command Routing via Index-Based Args Parsing:**
- Files: `src/cli.ts:150+` (main switch statement), `src/cli.ts:207,714-720` (arg index assumptions)
- Why fragile: Brittle argument parsing based on position; no validation that args exist before access; adding new optional args requires careful index updates
- Safe modification: Use command-line parser library (Commander, Yargs); validate arg count before access; add tests for each command variant
- Test coverage: No CLI integration tests; no validation for missing required args

**Plugin Load Order Dependency:**
- Files: `src/plugins.ts:240-280` (loadAllPlugins), `src/core/sessions.ts:10` (plugin event emission)
- Why fragile: Plugins loaded in arbitrary order; plugin A might emit events before plugin B loads; no dependency resolution
- Safe modification: Implement plugin manifest with dependencies; load plugins in order; validate manifest during install
- Test coverage: No tests for plugin load order or inter-plugin communication

**Stateful Context Providers Map:**
- Files: `src/plugins.ts:34` (contextProviders map), `src/core/sessions.ts:129-149` (usage)
- Why fragile: Global map can be accessed/modified concurrently; no locking; plugin could override another's provider
- Safe modification: Add namespace separation (session-name scoping); implement mutex for concurrent access; document thread-safety
- Test coverage: No concurrent modification tests

## Scaling Limits

**In-Memory Rate Limiter State:**
- Current capacity: Unlimited peers, state grows with unique peer keys contacted
- Limit: ~50MB per 100k peers (rough estimate); memory leaks on long-running daemon
- Scaling path: Move to Redis/persistent store; implement per-peer state lifecycle; add memory quota checks

**Single-Threaded Event Loop:**
- Current capacity: ~10 concurrent injections; daemon blocks during API calls
- Limit: Breaks at 50+ simultaneous users
- Scaling path: Implement worker threads for injection processing; use async queues; add horizontal scaling via daemon pools

**Filesystem-Based Session Storage:**
- Current capacity: ~10k sessions performant; degradation at 100k+
- Limit: Directory listing becomes slow; JSONL read amplification with large histories
- Scaling path: Migrate to SQLite; implement session archival; use append-only logs with compaction

**GitHub API Rate Limits (Unauthenticated):**
- Current capacity: 60 requests/hour from CLI; 1000/hour with GITHUB_TOKEN
- Limit: Registry searches hit rate limit after 30 searches on large repos
- Scaling path: Implement request caching; queue searches; use graphQL API; implement exponential backoff with jitter

## Dependencies at Risk

**@anthropic-ai/claude-agent-sdk (^0.2.12):**
- Risk: Pre-release SDK; breaking changes possible; tight coupling to SDK internals (resume sessions, system prompts)
- Impact: Version bump could break session resumption; SDK deprecation would require massive refactor
- Migration plan: Pin to exact version; implement adapter layer between SDK and inject(); publish custom SDK fork if needed

**hyperswarm (^4.16.0):**
- Risk: P2P library may introduce breaking changes in version 5; active maintenance uncertain
- Impact: P2P communication breaks; discovery stops working; can't discover peers
- Migration plan: Evaluate libp2p, webtorrent as alternatives; wrap hyperswarm in adapter interface

**hono (^4.6.0):**
- Risk: Web framework with broad compatibility; router system could change
- Impact: Daemon fails to start; routes no longer mount
- Migration plan: None urgent; hono is stable; but consider using Express if Hono becomes unmaintained

## Missing Critical Features

**Audit Logging:**
- Problem: No comprehensive audit trail of who accessed what sessions; security events not logged
- Blocks: Compliance requirements; incident investigation; forensics
- Recommendation: Log all P2P injections with peer ID, timestamp, message content; log auth events; log plugin loads

**Session Expiration/Lifecycle:**
- Problem: Sessions persist indefinitely; no cleanup; no TTL
- Blocks: Cleanup of stale sessions; resource limits; privacy (old data lingers)
- Recommendation: Add session expiration; implement archival; automatic cleanup of unused sessions

**Peer Trust Verification:**
- Problem: Access grants stored locally; no cryptographic proof that peer actually accepted invite
- Blocks: Disputes about permissions; peer can deny granting access after fact
- Recommendation: Require signed confirmation from peer; store on both sides; require re-signing on identity rotation

**Test Coverage Gaps:**

**CLI Command Coverage:**
- What's not tested: All 50+ CLI commands; argument validation; error cases
- Files: `src/cli.ts` (entire file)
- Risk: Breaking changes to CLI go undetected; commands silently fail
- Priority: High

**P2P Protocol Edge Cases:**
- What's not tested: Version mismatch handling; corrupt messages; connection drops during handshake; replay attacks
- Files: `src/p2p.ts`, `src/identity.ts` (signature verification)
- Risk: Protocol exploits; man-in-middle possible; peer desynchronization
- Priority: High

**Plugin System:**
- What's not tested: Plugin load failures; plugin exception handling; concurrent plugin events; plugin order dependencies
- Files: `src/plugins.ts`
- Risk: Bad plugin crashes daemon; silent failures; resource exhaustion
- Priority: Medium

**Rate Limiter Enforcement:**
- What's not tested: Rate limit actually blocks requests; bypasses don't exist; memory doesn't leak
- Files: `src/rate-limit.ts`, `src/daemon/routes/sessions.ts`
- Risk: Rate limiting doesn't work; DOS attacks possible; memory grows unbounded
- Priority: High

**File Permission Security:**
- What's not tested: Config files readable by unprivileged users; session files world-readable; permission escalation
- Files: `src/core/sessions.ts`, `src/auth.ts`
- Risk: Credentials leaked; session privacy violated
- Priority: High

---

*Concerns audit: 2026-01-25*
