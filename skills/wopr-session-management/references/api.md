# Sessions API

Base routes live under `/sessions`.

## List sessions
`GET /sessions`

## Get session details
`GET /sessions/:name`

## Get conversation history
`GET /sessions/:name/conversation?limit=<N>`

## Create a session
`POST /sessions`

Request body:
```json
{
  "name": "dev",
  "context": "Optional session context"
}
```

## Update session context
`PUT /sessions/:name`

Request body:
```json
{
  "context": "Updated session context"
}
```

## Delete session
`DELETE /sessions/:name`

## Inject message (non-streaming)
`POST /sessions/:name/inject`

Request body:
```json
{
  "message": "Your message",
  "from": "api"
}
```

## Inject message (streaming)
Send the same request as above but set the `Accept: text/event-stream` header to stream SSE chunks.
