# Plugin CLI Commands

## List plugins
`wopr plugin list`

## Install plugins
```
wopr plugin install wopr-plugin-discord
wopr plugin install wopr-p2p
wopr plugin install github:user/wopr-discord
wopr plugin install ./my-plugin
```

## Enable/disable/remove
- `wopr plugin enable <name>`
- `wopr plugin disable <name>`
- `wopr plugin remove <name>`

## Search npm
`wopr plugin search <query>`

## Plugin registries
- `wopr plugin registry list`
- `wopr plugin registry add <name> <url>`
- `wopr plugin registry remove <name>`
