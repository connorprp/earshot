# Earshot hub image: Node + the hub + the built dashboard + Claude Code CLI
# (the Agent SDK shells out to it; CLAUDE_CODE_OAUTH_TOKEN provides per-user
# subscription auth at runtime).
FROM node:22-slim

WORKDIR /app

# Claude Code CLI for the Agent SDK
RUN npm install -g @anthropic-ai/claude-code

COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

COPY dashboard/package*.json dashboard/
RUN cd dashboard && npm ci

COPY server server
COPY dashboard dashboard
# capture code + installer templates: the hub serves personalized installers
COPY capture capture
COPY mac mac
COPY windows windows
RUN cd dashboard && npx vite build

RUN mkdir -p out
ENV EARSHOT_HOSTED=1
EXPOSE 7071
CMD ["node", "server/index.js"]
