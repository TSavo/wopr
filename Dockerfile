FROM node:20-slim

WORKDIR /app

# Install git for plugin installation from GitHub
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npm run build

# Create data directory and set ownership for node user
RUN mkdir -p /data && chown -R node:node /data

# Create .claude directory for node user credentials
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node/.claude

ENV WOPR_HOME=/data

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Run entrypoint as root (it will drop to node user)
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/cli.js", "daemon", "run"]
