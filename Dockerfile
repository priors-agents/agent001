# agent001 in a container: `agent001 run` (the autopilot, and Telegram when TELEGRAM_BOT_TOKEN is set).
# Its folder lives on a volume at /data: the wallet (owner-only), the config and the state survive restarts and
# redeploys, and the image itself never holds a key.
#
#   docker build -t agent001 .
#   docker run --rm -it -v agent001-data:/data agent001 init        # once: makes the wallet, prints its address
#   docker run --rm -it -v agent001-data:/data agent001 join --bond # once funded: identity, bond, first line
#   docker run -d --restart unless-stopped -v agent001-data:/data agent001   # then the agent, for good
#
# On a hosting platform without a shell, set the key as the platform's secret AGENT001_WALLET_KEY instead.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY skills ./skills

# the agent's folder, on a volume, owned by the unprivileged user the agent runs as
RUN mkdir -p /data && chown node:node /data
ENV AGENT001_HOME=/data/.agent001 NODE_ENV=production
VOLUME ["/data"]
USER node

ENTRYPOINT ["node", "/app/bin/agent001.mjs"]
CMD ["run"]
