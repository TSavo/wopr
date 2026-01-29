# Troubleshooting Guide

Common issues and solutions for WOPR.

## Installation Issues

### npm install fails

**Problem:** `npm install -g wopr` fails with permission errors.

**Solutions:**
```bash
# Use npx (recommended)
npx wopr <command>

# Or fix npm permissions
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
npm install -g wopr

# Or use sudo (not recommended)
sudo npm install -g wopr
```

### Node.js version issues

**Problem:** WOPR requires Node.js 18+ but older version is installed.

**Solution:**
```bash
# Check version
node --version

# Install via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
nvm use 20
```

## Identity Issues

### "Identity not found"

**Problem:** WOPR commands fail with identity errors.

**Solution:**
```bash
# Initialize identity
wopr id init

# Check identity exists
ls -la ~/.wopr/identity.json

# Verify permissions (should be 0600)
chmod 600 ~/.wopr/identity.json
```

### "Cannot rotate keys"

**Problem:** Key rotation fails.

**Solutions:**
- Ensure daemon is running: `wopr daemon status`
- Check peer connectivity: `wopr peers list`
- Verify write permissions to `~/.wopr/`

## Daemon Issues

### Daemon won't start

**Problem:** `wopr daemon start` fails or exits immediately.

**Diagnose:**
```bash
# Check logs
wopr daemon logs

# Start in foreground for debugging
wopr daemon start --foreground

# Check port 7437 is free
lsof -i :7437
```

**Common causes:**
- Port 7437 already in use
- Permission issues with `~/.wopr/`
- Missing identity

**Solutions:**
```bash
# Kill existing process
pkill -f wopr-daemon

# Fix permissions
chmod 700 ~/.wopr

# Reinitialize
wopr id init
```

### "Connection refused"

**Problem:** CLI commands fail with connection errors.

**Solutions:**
```bash
# Check daemon status
wopr daemon status

# Start daemon
wopr daemon start

# Check if running on correct port
curl http://localhost:7437/sessions
```

## Session Issues

### Session not found

**Problem:** `wopr session inject mybot` returns "Session not found".

**Solutions:**
```bash
# List available sessions
wopr session list

# Create the session
wopr session create mybot "You are a helpful assistant."

# Check session files
ls ~/.wopr/sessions/
```

### "No providers available"

**Problem:** Session injection fails with provider error.

**Solutions:**
```bash
# Set API key
export ANTHROPIC_API_KEY="sk-ant-..."
# or
export KIMI_API_KEY="..."
# or
export OPENAI_API_KEY="sk-..."

# Or install a provider plugin
wopr plugin install github:TSavo/wopr-plugin-provider-kimi

# Check available providers
wopr providers list
```

### Session context not updating

**Problem:** Session responds with old context.

**Solutions:**
```bash
# Check context file
cat ~/.wopr/sessions/mybot.md

# Update context
wopr session create mybot "New context..."

# Or use context file
echo "New context" > ~/.wopr/sessions/mybot.md
```

## Plugin Issues

### Plugin won't install

**Problem:** `wopr plugin install` fails.

**Diagnose:**
```bash
# Check logs
wopr daemon logs

# Try manual install
cd ~/.wopr/plugins
git clone https://github.com/user/repo
cd repo
npm install
```

**Common causes:**
- Network issues
- Git not installed
- npm permission issues

### Plugin won't load

**Problem:** Installed plugin doesn't appear in list.

**Solutions:**
```bash
# List plugins
wopr plugin list

# Check if enabled
wopr plugin enable plugin-name

# Check daemon logs
wopr daemon logs | grep plugin

# Verify plugin structure
ls ~/.wopr/plugins/plugin-name/
# Should contain: package.json, index.js/ts
```

### Plugin configuration issues

**Problem:** Plugin not reading config correctly.

**Solutions:**
```bash
# Set config
wopr config set plugins.data.plugin-name '{"key": "value"}'

# Verify config
wopr config get plugins.data.plugin-name

# Check config file
cat ~/.wopr/config.json
```

## Channel Plugin Issues

### Discord plugin not responding

**Problem:** Bot appears offline or doesn't respond.

**Solutions:**
```bash
# Check bot token
wopr config get plugins.data.wopr-plugin-discord

# Verify bot is added to server
# Check Discord Developer Portal

# Restart daemon
wopr daemon restart

# Check logs
wopr daemon logs | grep -i discord
```

### Telegram bot not working

**Problem:** Telegram messages not received.

**Solutions:**
```bash
# Verify bot token with @BotFather
# Check webhook settings (should be polling)

# Test bot manually
curl https://api.telegram.org/bot<TOKEN>/getMe
```

### WhatsApp QR code not appearing

**Problem:** QR code for WhatsApp login doesn't show.

**Solutions:**
```bash
# Run interactively
wopr channels login whatsapp

# Check Baileys auth state
ls ~/.wopr/plugins/wopr-plugin-whatsapp/auth/

# Clear auth and retry
rm -rf ~/.wopr/plugins/wopr-plugin-whatsapp/auth/
```

## P2P Issues

### Cannot connect to peer

**Problem:** `wopr inject peer:session` fails.

**Diagnose:**
```bash
# Check peer list
wopr peers list

# Verify access
wopr access list

# Test connectivity
wopr peer ping <peer-id>
```

**Common causes:**
- Peer not in list
- Access not granted
- Network/firewall issues
- Daemon not running

### Invite claim fails

**Problem:** `wopr invite claim <token>` fails.

**Solutions:**
```bash
# Verify token format (should start with wop1://)
echo "wop1://..."

# Check token hasn't expired
# Generate new invite if needed

# Ensure you're claiming with correct identity
wopr id
```

### Discovery not finding peers

**Problem:** `wopr discover peers` shows nothing.

**Solutions:**
```bash
# Join topic
wopr discover join "ai-agents"

# Wait a moment (discovery is ephemeral)
sleep 5

# Check your profile is set
wopr discover profile set '{"name": "MyBot"}'

# Verify network connectivity
# Check firewall allows Hyperswarm DHT (UDP)
```

## Performance Issues

### High memory usage

**Problem:** WOPR daemon using too much memory.

**Solutions:**
```bash
# Check plugin memory usage
wopr plugin list

# Disable unnecessary plugins
wopr plugin disable plugin-name

# Limit conversation history
wopr session show mybot --limit 50

# Restart daemon
wopr daemon restart
```

### Slow response times

**Problem:** AI responses taking too long.

**Solutions:**
- Check provider status
- Switch to faster provider
- Reduce context window size
- Check network connectivity
- Review rate limits

## Debugging

### Enable debug logging

```bash
# Start with debug output
DEBUG=wopr:* wopr daemon start

# Or set environment variable
export DEBUG=wopr:*
wopr daemon start
```

### Check daemon logs

```bash
# View logs
wopr daemon logs

# Follow logs
wopr daemon logs --follow

# View specific lines
tail -100 ~/.wopr/daemon.log
```

### Test API directly

```bash
# Test daemon is running
curl http://localhost:7437/sessions

# Test injection
curl -X POST http://localhost:7437/sessions/mybot/inject \
  -H "Content-Type: application/json" \
  -d '{"message":"test","from":"curl"}'
```

### Reset everything

**WARNING:** This deletes all data!

```bash
# Stop daemon
wopr daemon stop

# Backup first
cp -r ~/.wopr ~/.wopr-backup-$(date +%Y%m%d)

# Reset
rm -rf ~/.wopr/*
wopr id init
```

## Getting Help

If issues persist:

1. **Check documentation:**
   - [Architecture](ARCHITECTURE.md)
   - [API Reference](API.md)
   - [Plugins](PLUGINS.md)

2. **Search issues:**
   - https://github.com/TSavo/wopr/issues

3. **Report bug:**
   - Include WOPR version: `wopr --version`
   - Include Node version: `node --version`
   - Include OS info
   - Include daemon logs
   - Steps to reproduce

## Common Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| `Identity not initialized` | No identity.json | Run `wopr id init` |
| `Session not found` | Session doesn't exist | Create with `wopr session create` |
| `No providers available` | No AI provider configured | Set API key or install provider |
| `Connection refused` | Daemon not running | Start with `wopr daemon start` |
| `Permission denied` | File permission issue | Fix with `chmod` |
| `Invite expired` | Token too old | Generate new invite |
| `Peer not found` | Unknown peer ID | Add peer or use discovery |
| `Plugin not found` | Plugin not installed | Install with `wopr plugin install` |
