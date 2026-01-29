# Docker Usage

Running WOPR in Docker for isolated, reproducible deployments.

## Quick Start

```bash
# Clone repository
git clone https://github.com/TSavo/wopr.git
cd wopr

# Build image
docker build -t wopr .

# Run container
docker run -d \
  --name wopr \
  -p 7437:7437 \
  -v wopr-data:/home/wopr/.wopr \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  wopr

# Check logs
docker logs -f wopr

# Execute commands
docker exec -it wopr wopr session list
```

## Building

### Basic Build

```bash
docker build -t wopr:latest .
```

### Build with specific Node version

```bash
docker build --build-arg NODE_VERSION=20 -t wopr:node20 .
```

### Multi-platform build

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t wopr:latest \
  --push .
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ANTHROPIC_API_KEY` | Claude API key | Optional* |
| `KIMI_API_KEY` | Kimi API key | Optional* |
| `OPENAI_API_KEY` | OpenAI API key | Optional* |
| `WOPR_TOPICS` | Discovery topics | Optional |
| `WOPR_HOME` | Data directory | Optional |

*At least one provider API key recommended

### Volumes

| Path | Description | Persistent |
|------|-------------|------------|
| `/home/wopr/.wopr` | WOPR data directory | Yes |
| `/home/wopr/.wopr/sessions` | Session contexts | Yes |
| `/home/wopr/.wopr/plugins` | Installed plugins | Yes |
| `/home/wopr/.wopr/skills` | Installed skills | Yes |

### Ports

| Port | Description |
|------|-------------|
| `7437` | HTTP API and WebSocket |

## Docker Compose

### Basic Setup

```yaml
version: '3.8'

services:
  wopr:
    build: .
    container_name: wopr
    ports:
      - "7437:7437"
    volumes:
      - wopr-data:/home/wopr/.wopr
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - WOPR_TOPICS=ai-agents,my-team
    restart: unless-stopped

volumes:
  wopr-data:
```

### With Discord Plugin

```yaml
version: '3.8'

services:
  wopr:
    image: wopr:latest
    container_name: wopr
    ports:
      - "7437:7437"
    volumes:
      - wopr-data:/home/wopr/.wopr
      - ./plugins:/home/wopr/.wopr/plugins:cached
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
    command: >
      sh -c "
        wopr plugin install github:TSavo/wopr-plugin-discord &&
        wopr plugin enable wopr-plugin-discord &&
        wopr daemon start --foreground
      "
    restart: unless-stopped

volumes:
  wopr-data:
```

### Production Setup

```yaml
version: '3.8'

services:
  wopr:
    image: wopr:latest
    container_name: wopr
    ports:
      - "127.0.0.1:7437:7437"  # Local only
    volumes:
      - wopr-data:/home/wopr/.wopr
      - /etc/localtime:/etc/localtime:ro
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - KIMI_API_KEY=${KIMI_API_KEY}
      - WOPR_TOPICS=${WOPR_TOPICS}
    networks:
      - wopr-network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:7437/sessions"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

  # Optional: Reverse proxy
  nginx:
    image: nginx:alpine
    container_name: wopr-nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - wopr
    networks:
      - wopr-network
    restart: unless-stopped

networks:
  wopr-network:
    driver: bridge

volumes:
  wopr-data:
    driver: local
```

## Running Commands

### Interactive Shell

```bash
docker exec -it wopr sh

# Then run WOPR commands
wopr session list
wopr session create mybot "You are helpful"
```

### One-off Commands

```bash
# Create session
docker exec wopr wopr session create mybot "You are helpful"

# Inject message
docker exec wopr wopr session inject mybot "Hello!"

# List plugins
docker exec wopr wopr plugin list
```

### Using docker-compose

```bash
docker-compose exec wopr wopr session list
```

## Data Persistence

### Backup

```bash
# Backup volume
docker run --rm \
  -v wopr-data:/source \
  -v $(pwd):/backup \
  alpine tar czf /backup/wopr-backup.tar.gz -C /source .

# Or copy directly
docker cp wopr:/home/wopr/.wopr ./wopr-backup
```

### Restore

```bash
# Restore from backup
docker run --rm \
  -v wopr-data:/target \
  -v $(pwd):/backup \
  alpine sh -c "cd /target && tar xzf /backup/wopr-backup.tar.gz"

# Or copy back
docker cp ./wopr-backup wopr:/home/wopr/.wopr
```

### Migration

```bash
# Export from host
wopr session list > sessions.txt

# Import to container
docker exec -i wopr sh << 'EOF'
while read session; do
  wopr session create "$session" "Context..."
done < sessions.txt
EOF
```

## Networking

### Expose to Internet

**WARNING:** Only with authentication!

```yaml
services:
  wopr:
    image: wopr:latest
    ports:
      - "7437:7437"
    # ...

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
```

nginx.conf:
```nginx
server {
    listen 443 ssl;
    server_name wopr.example.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    location / {
        auth_basic "WOPR";
        auth_basic_user_file /etc/nginx/.htpasswd;
        
        proxy_pass http://wopr:7437;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### Behind VPN

```yaml
services:
  wopr:
    image: wopr:latest
    network_mode: service:wireguard
    # ...

  wireguard:
    image: linuxserver/wireguard
    cap_add:
      - NET_ADMIN
    # ...
```

## Development

### Hot Reload

```yaml
services:
  wopr:
    build: .
    volumes:
      - .:/app
      - /app/node_modules
    command: npm run dev
```

### Debug Mode

```bash
docker run -it \
  -v wopr-data:/home/wopr/.wopr \
  -e DEBUG=wopr:* \
  wopr sh

# Inside container
wopr daemon start --foreground
```

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs wopr

# Check permissions
docker exec wopr ls -la /home/wopr/.wopr

# Fix permissions
docker exec wopr chown -R wopr:wopr /home/wopr/.wopr
```

### API not accessible

```bash
# Test from inside container
docker exec wopr curl http://localhost:7437/sessions

# Test from host
curl http://localhost:7437/sessions

# Check port binding
docker port wopr
```

### Plugin installation fails

```bash
# Check network
docker exec wopr ping github.com

# Install manually
docker exec -it wopr sh
cd ~/.wopr/plugins
git clone https://github.com/user/repo
```

## Security Best Practices

1. **Don't commit API keys** - Use environment variables
2. **Use read-only filesystem** where possible
3. **Run as non-root** - Container already uses `wopr` user
4. **Limit capabilities** - Drop unnecessary capabilities
5. **Use secrets management** - Docker secrets or external vault

```yaml
services:
  wopr:
    image: wopr:latest
    read_only: true
    tmpfs:
      - /tmp
    user: "1000:1000"
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE
    secrets:
      - anthropic_key

secrets:
  anthropic_key:
    file: ./secrets/anthropic_key.txt
```

## Examples

### Raspberry Pi Deployment

```yaml
services:
  wopr:
    image: wopr:latest
    # Use pre-built arm64 image
    platform: linux/arm64
    # ...
```

### Multiple Instances

```yaml
version: '3.8'

services:
  wopr-prod:
    image: wopr:latest
    container_name: wopr-prod
    ports:
      - "7437:7437"
    volumes:
      - wopr-prod-data:/home/wopr/.wopr
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

  wopr-dev:
    image: wopr:latest
    container_name: wopr-dev
    ports:
      - "7438:7437"
    volumes:
      - wopr-dev-data:/home/wopr/.wopr
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_DEV}

volumes:
  wopr-prod-data:
  wopr-dev-data:
```
