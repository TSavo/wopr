# Plugins API

Base routes live under `/plugins`.

## List installed plugins
`GET /plugins`

## Install plugin
`POST /plugins`

Request body:
```json
{
  "source": "wopr-plugin-discord"
}
```

## Remove plugin
`DELETE /plugins/:name`

## Enable/disable plugin
- `POST /plugins/:name/enable`
- `POST /plugins/:name/disable`

## Search plugins
`GET /plugins/search?q=<query>`

## Registries
- `GET /plugins/registries`
- `POST /plugins/registries` with `{ "name": "my-registry", "url": "https://..." }`
- `DELETE /plugins/registries/:name`
