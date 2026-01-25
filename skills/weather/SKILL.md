---
name: weather
description: Get current weather for any location using wttr.in
---

# Weather Skill

Get current weather conditions and forecasts.

## Usage

To get weather for a location:

```bash
curl -s "wttr.in/LOCATION?format=3"
```

For detailed forecast:

```bash
curl -s "wttr.in/LOCATION"
```

## Examples

```bash
# Simple one-liner
curl -s "wttr.in/Seattle?format=3"

# Full forecast
curl -s "wttr.in/Tokyo"

# Moon phase
curl -s "wttr.in/Moon"
```
