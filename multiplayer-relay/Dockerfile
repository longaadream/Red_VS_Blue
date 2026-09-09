FROM node:24-alpine
WORKDIR /srv/relay
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY protocol.mjs relay.mjs start.mjs ./
USER node
ENV NODE_ENV=production
CMD ["node", "start.mjs"]
