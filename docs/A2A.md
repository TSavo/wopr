# Agent-to-Agent (A2A) Communication

WOPR supports multi-agent coordination through Agent-to-Agent (A2A) tools. When enabled, AI sessions can discover, communicate with, and spawn other sessions for collaborative workflows.

## Overview

A2A enables:
- **Session Discovery** - Find active sessions/agents
- **Cross-Session Messaging** - Send messages between sessions
- **History Inspection** - View conversation context from other sessions
- **Dynamic Spawning** - Create specialist sessions on demand

## Enabling A2A

A2A is **opt-in** via configuration. Add to your `~/.wopr/config.json`:

```json
{
  "agents": {
    "a2a": {
      "enabled": true
    }
  }
}
```

Or via CLI:

```bash
wopr config set agents.a2a.enabled true
```

Restart the WOPR daemon after enabling:

```bash
wopr daemon restart
```

## A2A Tools

When A2A is enabled, the AI has access to these tools:

### sessions_list

Discover all active sessions.

**Parameters:**
- `limit` (number, optional): Maximum sessions to return (default: 50)

**Example:**
```
AI: Let me check what sessions are available.
[Tool: sessions_list]
→ Returns: [{"name": "discord-general", "id": "sess_abc123"}, ...]
```

### sessions_send

Send a message to another session.

**Parameters:**
- `session` (string, required): Target session name
- `message` (string, required): Message to send

**Example:**
```
User: Review this code
AI: I'll delegate to a code reviewer.
[Tool: sessions_send]
  session: "code-reviewer"
  message: "Review this Python function..."
→ Returns: Response from code-reviewer session
```

### sessions_history

Fetch conversation history from another session.

**Parameters:**
- `session` (string, required): Session to inspect
- `limit` (number, optional): Messages to fetch (default: 10, max: 50)

**Example:**
```
AI: Let me check what we discussed earlier.
[Tool: sessions_history]
  session: "main"
  limit: 5
→ Returns: Recent conversation transcript
```

### sessions_spawn

Create a new specialist session.

**Parameters:**
- `name` (string, required): Name for new session
- `purpose` (string, required): System context/prompt

**Example:**
```
User: Help me with Python
AI: I'll create a Python specialist.
[Tool: sessions_spawn]
  name: "python-expert"
  purpose: "You are a Python expert specializing in async programming..."
→ Returns: "Session 'python-expert' created successfully"
```

## Use Cases

### Specialist Coordination

```
User: Review this architecture document

Main Session:
1. Spawns "architect-reviewer" session
2. Sends document to reviewer
3. Receives analysis
4. Summarizes for user
```

### Multi-Step Workflows

```
User: Research quantum computing and write a blog post

Main Session:
1. Spawns "researcher" session
2. Researcher searches web, returns findings
3. Spawns "writer" session with research
4. Writer creates blog post
5. Main session presents final post
```

### Context Sharing

```
Discord Channel: @WOPR Summarize the Slack discussion

Discord Session:
1. Uses sessions_list to find Slack session
2. Uses sessions_history to fetch Slack transcript
3. Summarizes for Discord user
```

## Security Considerations

- **Same-instance only** - A2A works within one WOPR instance
- **All sessions equal** - Any session can message any other (when A2A is enabled)
- **No sandboxing** - Sessions share the same execution environment
- **Opt-in** - Disabled by default, must be explicitly enabled

## Provider Support

A2A requires provider support for tool calling:

| Provider | A2A Support | Notes |
|----------|-------------|-------|
| Anthropic | ✅ Full | Via Agent SDK |
| OpenAI | ⚠️ Partial | Requires function calling |
| Kimi | ⚠️ Partial | Depends on model support |

Currently tested primarily with Anthropic Claude via the Agent SDK.

## Troubleshooting

### "Tool not found" errors

Ensure:
1. A2A is enabled in config: `agents.a2a.enabled: true`
2. Using a provider that supports tools (Anthropic recommended)
3. WOPR daemon was restarted after enabling

### Tools don't appear in AI responses

- A2A tools are only passed when `agents.a2a.enabled` is `true`
- Check daemon logs: `wopr daemon logs | grep -i a2a`
- Verify provider plugin is up to date

### Session not found

- Session names are case-sensitive
- Use `sessions_list` to discover valid session names
- Sessions are created on first use (no pre-registration needed)

## Comparison with P2P

| Feature | A2A (Intra-instance) | P2P (Inter-instance) |
|---------|----------------------|----------------------|
| Scope | Same WOPR instance | Different WOPR instances |
| Discovery | `sessions_list` | `wopr discover` |
| Messaging | `sessions_send` | `wopr inject peer:session` |
| Use Case | Multi-agent workflows | Cross-device communication |
| Security | Shared environment | End-to-end encrypted |

## Future Enhancements

Potential future additions:
- Cross-instance A2A (federated agents)
- Agent capability advertisements
- Automatic agent discovery and routing
- Sandboxed subagents
- Agent marketplace/registry

## See Also

- [Architecture](ARCHITECTURE.md) - System design
- [Plugins](PLUGINS.md) - Plugin development
- [Events](events.md) - Event bus for reactive composition
