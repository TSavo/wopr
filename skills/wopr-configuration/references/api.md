# Config API

Base routes live under `/config`.

## Get all config
`GET /config`

## Get a specific key
`GET /config/:key`

## Set a key
`PUT /config/:key`

Request body:
```json
{
  "value": 7437
}
```

## Reset to defaults
`DELETE /config`
