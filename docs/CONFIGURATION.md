# Configuration Reference

Complete reference for WOPR configuration options.

## Configuration Sources

Configuration is loaded from (in order of precedence):

1. **Environment variables** - Highest priority
2. **Config file** - `~/.wopr/config.json`
3. **CLI flags** - Command-line arguments
4. **Defaults** - Lowest priority

## Environment Variables

### Core

| Variable | Description | Default |
|----------|-------------|---------|
| `WOPR_HOME` | Base data directory | `~/.wopr` |
| `WOPR_TOPICS` | Discovery topics (comma-separated) | - |
| `WOPR_PORT` | Daemon port | `7437` |
| `WOPR_HOST` | Daemon bind address | `localhost` |

### Provider API Keys

| Variable | Description | Required For |
|----------|-------------|--------------|
| `ANTHROPIC_API_KEY` | Claude API key | Anthropic provider |
| `KIMI_API_KEY` | Moonshot AI key | Kimi provider |
| `OPENAI_API_KEY` | OpenAI API key | OpenAI provider |

### Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub token for skill search | - |
| `DEBUG` | Debug logging (e.g., `wopr:*`) | - |

## Config File Structure

Location: `~/.wopr/config.json`

```json
{
  "daemon": {
    "port": 7437,
    "host": "localhost",
    "cors": true
  },
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}",
      "defaultModel": "claude-3-opus-20240229"
    },
    "kimi": {
      "apiKey": "${KIMI_API_KEY}",
      "defaultModel": "kimi-k2"
    }
  },
  "plugins": {
    "enabled": ["wopr-plugin-discord"],
    "data": {
      "wopr-plugin-discord": {
        "botToken": "...",
        "channelId": "..."
      }
    }
  },
  "discovery": {
    "enabled": true,
    "topics": ["ai-agents"],
    "profile": {
      "name": "MyBot",
      "skills": ["coding"]
    }
  },
  "security": {
    "rateLimit": {
      "requestsPerMinute": 100,
      "burstSize": 10
    },
    "maxMessageSize": 1048576
  }
}
```

## CLI Configuration

### Get/Set Config

```bash
# Get all config
wopr config get

# Get specific key
wopr config get daemon.port

# Set value
wopr config set daemon.port 8080

# Set nested value (JSON)
wopr config set plugins.data.discord '{"botToken":"..."}'

# Delete key
wopr config delete plugins.data.discord
```

### Provider Configuration

```bash
# Set default provider
wopr config set providers.default "kimi"

# Configure specific provider
wopr config set providers.anthropic.apiKey "sk-ant-..."
wopr config set providers.anthropic.defaultModel "claude-3-opus-20240229"
```

### Session Provider

```bash
# Set provider for specific session
wopr session set-provider mybot kimi

# With specific model
wopr session set-provider mybot kimi --model kimi-k2
```

## Plugin Configuration

### Enable/Disable

```bash
wopr plugin enable wopr-plugin-discord
wopr plugin disable wopr-plugin-discord
```

### Plugin Data

```bash
# Set plugin config
wopr config set plugins.data.wopr-plugin-discord.botToken "..."

# Get plugin config
wopr config get plugins.data.wopr-plugin-discord
```

### Via API

```bash
curl -X PUT http://localhost:7437/config/plugins.data.discord \
  -H "Content-Type: application/json" \
  -d '{"botToken":"...","channelId":"..."}'
```

## Discovery Configuration

### Topics

```bash
# Via environment
export WOPR_TOPICS="ai-agents,my-team"

# Via config
wopr config set discovery.topics '["ai-agents", "my-team"]'

# Via CLI
wopr discover join "ai-agents"
wopr discover join "my-team"
```

### Profile

```bash
# Set profile
wopr discover profile set '{
  "name": "MyBot",
  "description": "AI coding assistant",
  "skills": ["typescript", "review"]
}'

# Get profile
wopr discover profile get
```

## Security Configuration

### Rate Limiting

```json
{
  "security": {
    "rateLimit": {
      "enabled": true,
      "requestsPerMinute": 100,
      "burstSize": 10
    }
  }
}
```

### CORS

```json
{
  "daemon": {
    "cors": true,
    "corsOrigins": ["https://myapp.com"]
  }
}
```

## Configuration Keys Reference

### Daemon Keys

| Key | Type | Description | Default |
|-----|------|-------------|---------|
| `daemon.port` | number | HTTP API port | 7437 |
| `daemon.host` | string | Bind address | localhost |
| `daemon.cors` | boolean | Enable CORS | true |
| `daemon.corsOrigins` | string[] | Allowed origins | [*] |

### Provider Keys

| Key | Type | Description |
|-----|------|-------------|
| `providers.default` | string | Default provider ID |
| `providers.<id>.apiKey` | string | API key for provider |
| `providers.<id>.defaultModel` | string | Default model ID |
| `providers.<id>.baseUrl` | string | Custom API endpoint |

### Plugin Keys

| Key | Type | Description |
|-----|------|-------------|
| `plugins.enabled` | string[] | List of enabled plugins |
| `plugins.data.<name>` | object | Plugin-specific config |
| `plugins.registries` | string[] | Plugin registry URLs |

### Discovery Keys

| Key | Type | Description |
|-----|------|-------------|
| `discovery.enabled` | boolean | Enable discovery |
| `discovery.topics` | string[] | Default topics |
| `discovery.profile` | object | Default profile |
| `discovery.interval` | number | Announcement interval (ms) |

### Security Keys

| Key | Type | Description | Default |
|-----|------|-------------|---------|
| `security.rateLimit.enabled` | boolean | Rate limiting | true |
| `security.rateLimit.requestsPerMinute` | number | Rate limit | 100 |
| `security.maxMessageSize` | number | Max bytes | 1048576 |

## Environment Variable Substitution

Config values can reference environment variables:

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  }
}
```

Use `${VAR}` or `${VAR:-default}` for defaults.

## Validation

WOPR validates configuration on startup:

```bash
# Validate without starting
wopr config validate

# Test daemon with verbose config
wopr daemon start --verbose
```

## Migration

### From v0.x to v1.0

```bash
# Backup old config
cp ~/.wopr/config.json ~/.wopr/config.json.bak

# Config is auto-migrated on first run
wopr daemon start

# Check for warnings
wopr daemon logs
```

## Advanced Configuration

### Custom Provider Endpoint

```json
{
  "providers": {
    "custom": {
      "apiKey": "...",
      "baseUrl": "https://api.custom.com/v1",
      "defaultModel": "custom-model"
    }
  }
}
```

### Plugin Registry

```json
{
  "plugins": {
    "registries": [
      "https://wopr-plugins.example.com/registry.json"
    ]
  }
}
```

### Logging

```json
{
  "logging": {
    "level": "info",
    "file": "~/.wopr/wopr.log",
    "maxSize": "10m",
    "maxFiles": 5
  }
}
```

## Configuration Tips

1. **Use environment variables for secrets** - API keys, tokens
2. **Use config file for static settings** - Ports, defaults
3. **Use CLI for temporary changes** - Testing, debugging
4. **Validate after changes** - `wopr config validate`
5. **Check logs for errors** - `wopr daemon logs`
