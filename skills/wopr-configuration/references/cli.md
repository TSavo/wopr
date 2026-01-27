# Config CLI Commands

- `wopr config get [key]`
- `wopr config set <key> <value>`
- `wopr config reset`
- `wopr config list`

Examples:

```bash
wopr config get daemon.port
wopr config set daemon.port 7437
wopr config set plugins.data.router '{"routes":[]}'
```
