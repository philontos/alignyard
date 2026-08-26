FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4500 \
    ALIGNYARD_DATA_DIR=/data
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY web ./web
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 4500
VOLUME ["/data"]
CMD ["./node_modules/.bin/tsx", "server/platform/main.ts"]
