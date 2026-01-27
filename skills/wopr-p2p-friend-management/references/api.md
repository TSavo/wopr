# P2P Friend API

Base routes live under `/peers`.

## List peers you can inject to
`GET /peers`

## List access grants (who can inject to you)
`GET /peers/access`

## Create invite
`POST /peers/invite`

Request body:
```json
{
  "peerPubkey": "wopr://...",
  "sessions": ["*"]
}
```

## Claim invite
`POST /peers/claim`

Request body:
```json
{
  "token": "wop1://..."
}
```

## List outgoing invites
`GET /peers/invites`

## Revoke outgoing invite
`DELETE /peers/invites/:token`

## Update peer sessions (who you can inject to)
`PUT /peers/:id`

Request body:
```json
{
  "sessions": ["dev", "support"],
  "caps": ["inject"]
}
```

## Update access grants (who can inject to you)
`PUT /peers/:id/access`

Request body:
```json
{
  "sessions": ["dev"],
  "caps": ["inject"]
}
```

## Forget peer
`DELETE /peers/:id/forget`

## Revoke peer access
`DELETE /peers/:id`
