# Skills API

Base routes live under `/skills`.

## List installed skills
`GET /skills`

## Create a skill
`POST /skills`

Request body:
```json
{
  "name": "my-skill",
  "description": "Optional description"
}
```

## Install a skill
`POST /skills/install`

Request body:
```json
{
  "source": "github:owner/repo/path/to/skill",
  "name": "optional-name"
}
```

## Remove a skill
`DELETE /skills/:name`

## Search registries
`GET /skills/search?q=<query>`

## Clear cache
`POST /skills/cache/clear`

## Registries
- `GET /skills/registries`
- `POST /skills/registries` with `{ "name": "my-registry", "url": "https://..." }`
- `DELETE /skills/registries/:name`
