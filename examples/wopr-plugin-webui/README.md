# WOPR Web UI Plugin (Example)

This plugin serves a lightweight web UI for managing WOPR sessions, peers, invites, plugins, skills, and config.

## Install

```bash
wopr plugin install ./examples/wopr-plugin-webui
wopr plugin enable webui
```

## Config

Stored under `plugins.data.webui`:

```json
{
  "host": "127.0.0.1",
  "port": 7331,
  "baseUrl": "http://127.0.0.1:7437",
  "auth": {
    "mode": "none",
    "token": "",
    "password": ""
  }
}
```

## Usage

Open `http://127.0.0.1:7331` in your browser.
