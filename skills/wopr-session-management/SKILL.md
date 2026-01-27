---
name: wopr-session-management
description: Manage WOPR sessions via CLI or daemon API. Use when creating, listing, inspecting, injecting into, or deleting sessions, or when you need session conversation history or context management details.
---

# WOPR Session Management

Use this skill to operate on sessions (create, inject, inspect, delete) and to retrieve conversation history.

## Quick workflow

1. Identify the session name and desired context.
2. Create or update the session context.
3. Inject messages and optionally stream responses.
4. List/show/delete sessions as needed.

## Progressive disclosure

- For exact CLI commands and flags, read `references/cli.md`.
- For daemon API endpoints (including streaming), read `references/api.md`.

## Guardrails

- Keep session names stable; they are the lookup key for context and logs.
- Use conversation history endpoints when you need auditability or middleware/channel traces.
