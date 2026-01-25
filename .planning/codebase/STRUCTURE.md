# Codebase Structure

**Analysis Date:** 2026-01-25

## Directory Layout

```
wopr/
├── src/                      # Main source code (TypeScript)
│   ├── cli.ts                # CLI entry point (1046 lines)
│   ├── client.ts             # HTTP client for daemon communication
│   ├── types.ts              # Shared type definitions
│   ├── paths.ts              # Directory and file paths
│   ├── auth.ts               # OAuth and API key authentication
│   ├── identity.ts           # Cryptographic identity (Ed25519, X25519)
│   ├── trust.ts              # Access grants and peer authorization
│   ├── p2p.ts                # Hyperswarm P2P messaging
│   ├── discovery.ts          # Topic-based peer discovery
│   ├── plugins.ts            # Plugin system and loading
│   ├── rate-limit.ts         # Rate limiting and replay protection
│   ├── core/                 # Business logic modules
│   │   ├── index.ts          # Module exports
│   │   ├── sessions.ts       # Session and conversation management
│   │   ├── skills.ts         # Skill discovery and formatting
│   │   ├── cron.ts           # Cron scheduling and execution
│   │   ├── config.ts         # Configuration management
│   │   └── registries.ts     # Skill and plugin registry management
│   ├── daemon/               # HTTP daemon
│   │   ├── index.ts          # Daemon startup, Hono app creation
│   │   ├── ws.ts             # WebSocket handler for streaming
│   │   └── routes/           # API route handlers
│   │       ├── index.ts      # Route barrel exports
│   │       ├── sessions.ts   # Session endpoints (POST/GET/PUT/DELETE)
│   │       ├── crons.ts      # Cron endpoints
│   │       ├── auth.ts       # Auth status endpoints
│   │       ├── peers.ts      # Peer management endpoints
│   │       ├── plugins.ts    # Plugin management endpoints
│   │       ├── skills.ts     # Skill management endpoints
│   │       ├── identity.ts   # Identity endpoints
│   │       ├── discover.ts   # Discovery endpoints
│   │       └── config.ts     # Config endpoints
│   └── types/
│       └── hyperswarm.d.ts   # Type definitions for Hyperswarm
├── web/                      # Web UI (Solid.js + Vite)
│   ├── src/
│   │   ├── index.tsx         # React DOM render entry
│   │   ├── App.tsx           # Root component
│   │   ├── components/
│   │   │   └── Settings.tsx  # Settings panel component
│   │   ├── lib/
│   │   │   └── api.ts        # Fetch wrapper for HTTP calls
│   │   └── index.css         # Tailwind + custom styles
│   ├── index.html            # HTML template
│   ├── vite.config.ts        # Vite build config
│   ├── tsconfig.json         # TypeScript config for web
│   ├── tailwind.config.js    # Tailwind CSS config
│   └── postcss.config.js     # PostCSS config
├── docs/                     # Documentation files
├── examples/                 # Example configurations/skills
├── .planning/
│   └── codebase/             # GSD codebase analysis documents
├── package.json              # Root npm config
├── tsconfig.json             # Root TypeScript config
├── Dockerfile                # Docker image definition
├── docker-compose.yml        # Docker Compose setup
├── README.md                 # Project documentation
└── [runtime-generated]
    ├── dist/                 # Compiled JavaScript (tsc output)
    ├── node_modules/         # Dependencies
    ├── ~/.wopr/              # User data directory (WOPR_HOME)
    │   ├── config.json       # User configuration
    │   ├── identity.json     # Cryptographic keypairs
    │   ├── auth.json         # OAuth/API key credentials
    │   ├── access.json       # Access grants for peers
    │   ├── peers.json        # Known peers
    │   ├── sessions.json     # Session name → ID mapping
    │   ├── crons.json        # Cron job definitions
    │   ├── registries.json   # Skill registry URLs
    │   ├── daemon.pid        # Daemon process ID
    │   ├── daemon.log        # Daemon output log
    │   ├── sessions/         # Session data
    │   │   ├── <name>.md     # Session context (optional)
    │   │   └── <name>.conversation.jsonl  # Conversation log
    │   ├── skills/           # Installed skills
    │   │   └── <skill-name>/
    │   │       └── SKILL.md  # Skill definition
    │   └── plugins/          # Installed plugins
    │       └── <plugin-name>/
    │           ├── package.json
    │           └── [plugin files]
    └── web/dist/             # Built web UI (Vite output)
```

## Directory Purposes

**`src/`:** Main application source code (TypeScript).

**`src/core/`:** Pure business logic, no framework dependencies. Exports session management, skill discovery, cron scheduling, config management, and registry handling.

**`src/daemon/`:** HTTP server using Hono framework. Contains application server setup, route mounting, WebSocket coordination.

**`src/daemon/routes/`:** Hono route handlers implementing REST endpoints. Each file corresponds to a feature area (sessions, crons, peers, etc.).

**`web/`:** Browser-based UI built with Solid.js. Communicates with daemon via HTTP and WebSocket. Separate `tsconfig.json` for browser environment.

**`docs/`:** Markdown documentation files.

**`examples/`:** Sample configurations and skill definitions for users to reference.

**`.planning/codebase/`:** GSD codebase analysis documents (this directory).

**`~/.wopr/` (WOPR_HOME):** User data directory. All state persisted to JSON files here. Can be overridden via `WOPR_HOME` env var.

## Key File Locations

**Entry Points:**

- `src/cli.ts`: CLI command handler (1046 lines) - main entry point for `wopr` command
- `src/daemon/index.ts`: Daemon startup - main entry point for `wopr daemon start`
- `web/src/index.tsx`: Web UI entry - Solid.js render point

**Configuration:**

- `src/core/config.ts`: ConfigManager class for loading/saving/merging config
- `src/paths.ts`: Path constants (WOPR_HOME, SESSIONS_DIR, etc.)
- `tsconfig.json`: Root TypeScript configuration

**Core Logic:**

- `src/core/sessions.ts`: Session CRUD, injection, conversation logging
- `src/core/skills.ts`: Skill discovery, frontmatter parsing, XML formatting
- `src/core/cron.ts`: Cron parsing (crontab syntax), scheduling, execution
- `src/identity.ts`: Key generation, signing, verification, encryption/decryption
- `src/trust.ts`: Access grant management, peer authorization

**API Implementation:**

- `src/daemon/routes/sessions.ts`: Session endpoints (GET, POST, PUT, DELETE, inject)
- `src/daemon/routes/peers.ts`: Peer management, P2P injection
- `src/daemon/routes/crons.ts`: Cron CRUD
- `src/daemon/routes/discover.ts`: Topic join/leave, profile management
- `src/daemon/routes/auth.ts`: Auth status, login flow

**Testing:** No test files in current structure (testing patterns not yet established)

## Naming Conventions

**Files:**

- `*.ts`: TypeScript source files
- `*.tsx`: TypeScript React (Solid.js) components
- `.json`: Configuration or data files (config.json, sessions.json, etc.)
- `.md`: Markdown documentation or skill definitions

**Directories:**

- `src/`: Source code directory
- `src/core/`: Core business logic modules
- `src/daemon/`: Daemon HTTP server
- `src/daemon/routes/`: HTTP route handlers
- `web/`: Web UI project
- `~/.wopr/sessions/`: Session data storage
- `~/.wopr/skills/`: Installed skills
- `~/.wopr/plugins/`: Installed plugins

**Functions:**

- Camel case: `camelCase` (e.g., `getSessions()`, `injectMessage()`)
- Utilities: `shortKey()`, `getTopic()` (helper functions)
- Handlers: `handleWebSocketMessage()`, `handleMessage()` (message processors)

**Types:**

- PascalCase: `Session`, `CronJob`, `Identity`, `AccessGrant`, `Profile` (interfaces in `types.ts`)
- Suffixes: `Handler`, `Callback`, `State`, `Config` (distinguishing patterns)

**Variables:**

- Camel case: `sessionName`, `cronJob`, `peerKey`
- Constants: `UPPERCASE`: `WOPR_HOME`, `DEFAULT_PORT`, `PROTOCOL_VERSION`
- Prefixes: `is*` for booleans: `isRunning`, `isAuthorized`

## Where to Add New Code

**New Feature (e.g., new session command):**

1. Add endpoint logic in `src/core/sessions.ts` (pure business logic)
2. Add HTTP route in `src/daemon/routes/sessions.ts` (endpoint handler)
3. Add CLI command handler in `src/cli.ts` (command parsing)
4. Add client method in `src/client.ts` (HTTP wrapper)
5. Add types to `src/types.ts` if needed

**New Daemon Route (e.g., for new API surface):**

1. Create `src/daemon/routes/featurename.ts` with Hono router
2. Import and mount in `src/daemon/index.ts`: `app.route("/featurename", featurenameRouter)`
3. Export router from `src/daemon/routes/index.ts`

**New Component/Module:**

- **Core logic**: `src/core/<feature>.ts` (session-independent business logic)
- **Cryptography**: `src/<feature>.ts` at root level (e.g., `identity.ts`, `p2p.ts`)
- **Daemon-specific**: `src/daemon/<feature>.ts` or `src/daemon/routes/<feature>.ts`
- **Web UI**: `web/src/components/<Feature>.tsx` or `web/src/lib/<feature>.ts`

**Utilities:**

- Shared helpers: `src/<utility>.ts` (e.g., `paths.ts`, `auth.ts`, `rate-limit.ts`)
- Web-specific: `web/src/lib/<utility>.ts` (e.g., `api.ts`)

**Type Additions:**

- Core types: `src/types.ts` (Session, Identity, P2PMessage, etc.)
- Type declarations: `src/types/` directory (e.g., `hyperswarm.d.ts` for external packages)

## Special Directories

**`~/.wopr/sessions/`:**

- Purpose: Persistent session storage
- Generated: Yes (created by `createSession()` or `inject()`)
- Committed: No (user data)
- Structure: `<session-name>.md` (context) and `<session-name>.conversation.jsonl` (logs)

**`~/.wopr/skills/`:**

- Purpose: Installed skill definitions
- Generated: Yes (populated by `wopr skill install`)
- Committed: No (user customization)
- Structure: `<skill-name>/SKILL.md` with YAML frontmatter

**`~/.wopr/plugins/`:**

- Purpose: Installed plugin packages
- Generated: Yes (populated by `wopr plugin install`)
- Committed: No (user extensions)
- Structure: `<plugin-name>/` with package.json and plugin files

**`dist/`:**

- Purpose: Compiled JavaScript output
- Generated: Yes (by `pnpm build` → `tsc`)
- Committed: No (build artifact)
- Structure: Mirrors `src/` directory structure

**`web/dist/`:**

- Purpose: Built web UI
- Generated: Yes (by `pnpm build` in web directory → Vite)
- Committed: No (build artifact)
- Structure: Minified HTML, CSS, JS files for deployment

**`.planning/codebase/`:**

- Purpose: GSD codebase analysis and documentation
- Generated: Yes (by GSD map-codebase command)
- Committed: Yes (checked into repo)
- Files: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, STACK.md, INTEGRATIONS.md, CONCERNS.md

## Import Path Organization

**Pattern observed:**

1. Node.js built-ins: `import { readFileSync } from "fs"`
2. Third-party packages: `import { Hono } from "hono"`
3. Relative imports: `import { getSessions } from "../core/sessions.js"`
4. Type imports: `import type { Session } from "../types.js"`

**Path aliases:** None currently configured (all relative paths with `.js` extension for ES modules)

**Module format:** ES modules (`"type": "module"` in package.json), so all imports use `.js` extension

---

*Structure analysis: 2026-01-25*
