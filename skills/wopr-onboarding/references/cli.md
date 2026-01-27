# Onboarding CLI

## Wizard
- `wopr init`

The wizard walks through:
- daemon host/port/autostart
- daemon API auth (none/token/password)
- Anthropic API key
- OAuth client setup
- Discord bot token (optional)
- discovery topics/auto-join
- identity initialization (if daemon running)
- plugin installs (if daemon running; suggested: `./examples/wopr-plugin-webui`)
- skill installs (if daemon running)
- optional session creation

## Supporting commands
- `wopr daemon start`
- `wopr id init`
- `wopr plugin install <source>`
- `wopr skill install <source>`
- `wopr session create <name> [context]`
