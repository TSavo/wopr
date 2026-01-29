# WOPR HTTP API

The WOPR daemon exposes an HTTP API for programmatic access. Default port: `7437`.

**Base URL:** `http://localhost:7437`

## Authentication

Currently, the API is designed for local access. For remote deployments, use a reverse proxy with authentication (nginx, etc.).

## Content Types

All endpoints accept and return `application/json` unless otherwise specified.

## Sessions

### List Sessions

```http
GET /sessions
```

**Response:**
```json
{
  "sessions": [
    {
      "name": "mybot",
      "id": "sess_abc123",
      "context": "You are a helpful assistant...",
      "created": 1705000000000
    }
  ]
}
```

### Get Session

```http
GET /sessions/:name
```

**Response:**
```json
{
  "name": "mybot",
  "id": "sess_abc123",
  "context": "You are a helpful assistant..."
}
```

### Create Session

```http
POST /sessions
Content-Type: application/json

{
  "name": "mybot",
  "context": "You are a helpful assistant."
}
```

**Response:**
```json
{
  "name": "mybot",
  "context": "You are a helpful assistant.",
  "created": true
}
```

### Delete Session

```http
DELETE /sessions/:name
```

**Response:**
```json
{
  "deleted": true
}
```

### Get Conversation History

```http
GET /sessions/:name/conversation?limit=50
```

**Response:**
```json
{
  "name": "mybot",
  "entries": [
    {
      "ts": 1705000000000,
      "from": "user",
      "content": "Hello!",
      "type": "message"
    },
    {
      "ts": 1705000001000,
      "from": "WOPR",
      "content": "Hello! How can I help you today?",
      "type": "response"
    }
  ],
  "count": 2
}
```

### Inject Message (Streaming)

```http
POST /sessions/:name/inject
Content-Type: application/json

{
  "message": "Hello!",
  "from": "api",
  "silent": false
}
```

**Response:** SSE stream

```
event: chunk
data: {"type":"text","content":"Hello"}

event: chunk
data: {"type":"text","content":"!"}

event: done
data: {"type":"complete","response":"Hello! How can I help?","sessionId":"sess_abc123","cost":0.0023}
```

**Stream events:**
- `chunk` - Text chunk from AI
- `tool_use` - Tool execution started
- `done` - Complete response with metadata
- `error` - Error occurred

### Log Message (No AI Response)

```http
POST /sessions/:name/log
Content-Type: application/json

{
  "message": "Context information",
  "from": "system"
}
```

**Response:**
```json
{
  "logged": true
}
```

## Plugins

### List Plugins

```http
GET /plugins
```

**Response:**
```json
{
  "plugins": [
    {
      "name": "wopr-plugin-discord",
      "version": "1.0.0",
      "description": "Discord integration",
      "source": "github",
      "enabled": true,
      "installedAt": 1705000000000
    }
  ]
}
```

### Install Plugin

```http
POST /plugins
Content-Type: application/json

{
  "source": "github:TSavo/wopr-plugin-discord"
}
```

**Response:**
```json
{
  "installed": true,
  "plugin": {
    "name": "wopr-plugin-discord",
    "version": "1.0.0",
    "description": "Discord integration",
    "source": "github",
    "enabled": true
  }
}
```

**Source formats:**
- `github:user/repo` - GitHub repository
- `npm:package-name` - npm package
- `/path/to/plugin` - Local path

### Remove Plugin

```http
DELETE /plugins/:name
```

**Response:**
```json
{
  "removed": true
}
```

### Enable/Disable Plugin

```http
POST /plugins/:name/enable
POST /plugins/:name/disable
```

**Response:**
```json
{
  "enabled": true,
  "name": "wopr-plugin-discord"
}
```

### Get Web UI Extensions

```http
GET /plugins/ui
```

**Response:**
```json
{
  "extensions": [
    {
      "id": "discord-nav",
      "label": "Discord",
      "href": "/discord",
      "icon": "message-circle"
    }
  ]
}
```

### Get UI Components

```http
GET /plugins/components
```

**Response:**
```json
{
  "components": [
    {
      "id": "discord-panel",
      "type": "panel",
      "component": "DiscordPanel",
      "props": {}
    }
  ]
}
```

## Identity

### Get Identity

```http
GET /identity
```

**Response:**
```json
{
  "publicKey": "abc123...",
  "shortId": "MCoxK8f2",
  "encryptPub": "xyz789..."
}
```

### Rotate Keys

```http
POST /identity/rotate
Content-Type: application/json

{
  "broadcast": true
}
```

**Response:**
```json
{
  "rotated": true,
  "newShortId": "MCoxK8f2",
  "broadcast": true
}
```

## Peers

### List Peers

```http
GET /peers
```

**Response:**
```json
{
  "peers": [
    {
      "id": "ABC123...",
      "shortId": "ABC123",
      "name": "Alice",
      "sessions": ["help", "dev"],
      "caps": ["inject"]
    }
  ]
}
```

### Get Peer

```http
GET /peers/:id
```

### Add Peer

```http
POST /peers
Content-Type: application/json

{
  "publicKey": "abc123...",
  "encryptPub": "xyz789...",
  "name": "Alice"
}
```

### Remove Peer

```http
DELETE /peers/:id
```

## Access Control

### List Access Grants

```http
GET /access
```

**Response:**
```json
{
  "grants": [
    {
      "id": "grant_abc123",
      "peerKey": "abc123...",
      "peerEncryptPub": "xyz789...",
      "sessions": ["help"],
      "caps": ["inject"],
      "created": 1705000000000
    }
  ]
}
```

### Create Invite

```http
POST /access/invites
Content-Type: application/json

{
  "peerPublicKey": "abc123...",
  "sessions": ["help"],
  "caps": ["inject"]
}
```

**Response:**
```json
{
  "token": "wop1://eyJ2IjoxLC...",
  "expires": 1705600000000
}
```

### Claim Invite

```http
POST /access/claims
Content-Type: application/json

{
  "token": "wop1://eyJ2IjoxLC..."
}
```

**Response:**
```json
{
  "claimed": true,
  "peer": {
    "id": "ABC123...",
    "shortId": "ABC123",
    "sessions": ["help"]
  }
}
```

### Revoke Access

```http
DELETE /access/:grantId
```

## Cron Jobs

### List Crons

```http
GET /crons
```

**Response:**
```json
{
  "crons": [
    {
      "name": "morning",
      "schedule": "0 9 * * *",
      "session": "daily",
      "message": "Good morning!",
      "enabled": true
    }
  ]
}
```

### Add Cron

```http
POST /crons
Content-Type: application/json

{
  "name": "morning",
  "schedule": "0 9 * * *",
  "session": "daily",
  "message": "Good morning! What's the plan?"
}
```

**Schedule formats:**
- Cron: `0 9 * * *` (daily at 9am)
- Natural: `@daily`, `@hourly`
- Relative: `+1h`, `+30m`

### Remove Cron

```http
DELETE /crons/:name
```

### Run Cron Now

```http
POST /crons/:name/run
```

## Skills

### List Skills

```http
GET /skills
```

**Response:**
```json
{
  "skills": [
    {
      "name": "code-review",
      "description": "Code review skill",
      "source": "github:anthropics/claude-skills"
    }
  ]
}
```

### Install Skill

```http
POST /skills
Content-Type: application/json

{
  "source": "github:anthropics/claude-skills/code-review"
}
```

### Remove Skill

```http
DELETE /skills/:name
```

## Configuration

### Get Config

```http
GET /config
GET /config/:key
```

**Response:**
```json
{
  "key": "plugins.data.discord",
  "value": {
    "botToken": "...",
    "channelId": "..."
  }
}
```

### Set Config

```http
PUT /config/:key
Content-Type: application/json

{
  "value": { "botToken": "..." }
}
```

### Delete Config Key

```http
DELETE /config/:key
```

## Discovery

### Join Topic

```http
POST /discover/topics
Content-Type: application/json

{
  "topic": "ai-agents"
}
```

### Leave Topic

```http
DELETE /discover/topics/:topic
```

### List Topics

```http
GET /discover/topics
```

### Set Profile

```http
PUT /discover/profile
Content-Type: application/json

{
  "name": "Alice",
  "skills": ["coding", "review"],
  "description": "AI coding assistant"
}
```

### List Discovered Peers

```http
GET /discover/peers
```

**Response:**
```json
{
  "peers": [
    {
      "id": "ABC123...",
      "shortId": "ABC123",
      "profile": {
        "name": "Bob",
        "skills": ["design"]
      },
      "topics": ["ai-agents"]
    }
  ]
}
```

### Connect to Peer

```http
POST /discover/connect
Content-Type: application/json

{
  "peerId": "ABC123..."
}
```

## Providers

### List Providers

```http
GET /providers
```

**Response:**
```json
{
  "providers": [
    {
      "id": "kimi",
      "name": "Moonshot AI Kimi",
      "available": true,
      "defaultModel": "kimi-k2"
    },
    {
      "id": "anthropic",
      "name": "Anthropic Claude",
      "available": false,
      "defaultModel": "claude-3-opus-20240229"
    }
  ]
}
```

### Get Provider

```http
GET /providers/:id
```

### Set Session Provider

```http
PUT /sessions/:name/provider
Content-Type: application/json

{
  "provider": "kimi",
  "model": "kimi-k2"
}
```

## Middleware

### List Middlewares

```http
GET /middlewares
```

**Response:**
```json
{
  "middlewares": [
    {
      "name": "filter",
      "priority": 100,
      "enabled": true
    }
  ]
}
```

### Get Middleware Chain

```http
GET /middlewares/chain
```

**Response:**
```json
{
  "chain": [
    { "name": "filter", "priority": 100, "enabled": true },
    { "name": "transform", "priority": 50, "enabled": true }
  ]
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": "Description of what went wrong",
  "code": "ERROR_CODE",
  "details": {}
}
```

**Common status codes:**
- `400` - Bad Request (invalid input)
- `404` - Not Found
- `409` - Conflict (e.g., session already exists)
- `500` - Internal Server Error

## WebSocket API

Some endpoints support WebSocket for real-time updates:

```javascript
const ws = new WebSocket('ws://localhost:7437/ws');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data.type, data.payload);
};
```

**Events:**
- `session:injection` - Message injected to session
- `session:stream` - Streaming response chunk
- `peer:connected` - Peer connected
- `peer:disconnected` - Peer disconnected

## Rate Limiting

Default rate limits (configurable):
- 100 requests per minute per IP
- 10 concurrent streaming connections

## SDK Examples

### JavaScript/TypeScript

```typescript
const WOPR_API = 'http://localhost:7437';

async function injectMessage(session: string, message: string) {
  const response = await fetch(`${WOPR_API}/sessions/${session}/inject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, from: 'api' }),
  });
  
  // Handle SSE stream
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    // Process chunk
  }
}
```

### Python

```python
import requests

WOPR_API = 'http://localhost:7437'

def create_session(name: str, context: str):
    resp = requests.post(f'{WOPR_API}/sessions', json={
        'name': name,
        'context': context
    })
    return resp.json()

def list_sessions():
    resp = requests.get(f'{WOPR_API}/sessions')
    return resp.json()['sessions']
```

### cURL

```bash
# Create session
curl -X POST http://localhost:7437/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"mybot","context":"You are helpful"}'

# Inject message (streaming)
curl -X POST http://localhost:7437/sessions/mybot/inject \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello!","from":"curl"}'

# List plugins
curl http://localhost:7437/plugins
```
