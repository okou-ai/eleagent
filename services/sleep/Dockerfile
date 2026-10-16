FROM node:24-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY lib ./lib
COPY extensions ./extensions
COPY pi-agent ./pi-agent
COPY run.mjs scheduler.mjs ./
COPY prompts ./prompts
RUN chmod -R a+rX /app && chown -R node:node /app/pi-agent
USER node
ENV HOME=/home/node
CMD ["node", "scheduler.mjs"]
