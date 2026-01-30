#!/bin/sh
set -e

# Fix ownership of data directory (volume mount may override)
chown -R node:node /data

# Copy Claude credentials if mounted (as root, then chown to node)
if [ -f /claude-creds/.credentials.json ]; then
  install -D -o node -g node -m 600 /claude-creds/.credentials.json /home/node/.claude/.credentials.json
  echo "Claude credentials copied"
fi

# Run the main command as node user
exec runuser -u node -- "$@"
