FROM node:24-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY graph.mjs server.mjs main.mjs mcp.mjs validation.mjs archive.mjs ./
USER node
CMD ["node", "main.mjs"]
