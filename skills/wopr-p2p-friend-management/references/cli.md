# P2P Friend CLI Commands

## Handshake helpers
- `wopr p2p friend add <peer-pubkey> [session...] [--token <token>]`
- `wopr invite <peer-pubkey> <session...>`
- `wopr invite claim <token>`

## Outgoing invites
- `wopr p2p invites`
- `wopr p2p invites revoke <token>`

## Access grants (who can inject to you)
- `wopr access`
- `wopr access set <peer> <session...>`
- `wopr revoke <peer>`

## Peers (who you can inject to)
- `wopr peers`
- `wopr peers name <id> <name>`
- `wopr peers set <id> <session...>`
- `wopr peers forget <id>`
