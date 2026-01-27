---
name: wopr-p2p-friend-management
description: Manage WOPR P2P friends, invites, and access grants via CLI or daemon API. Use when creating invites, listing/revoking invites, claiming tokens, updating peer sessions, or adjusting access grants.
---

# WOPR P2P Friend Management

Use this skill to manage the P2P friend lifecycle: create/claim invites, list and revoke outgoing invites, adjust access grants, and update or forget peers.

## Quick workflow

1. Create or claim an invite to establish trust.
2. List outgoing invites and revoke any that are stale.
3. Update access grants (who can inject to you) or peer sessions (who you can inject to).
4. Forget peers that are no longer needed.

## Progressive disclosure

- For CLI commands and usage, read `references/cli.md`.
- For daemon API endpoints and request bodies, read `references/api.md`.
