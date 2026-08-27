FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4500 \
    ALIGNYARD_DATA_DIR=/data
WORKDIR /app
RUN install -d -o node -g node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY web ./web
USER node
EXPOSE 4500
VOLUME ["/data"]
CMD ["./node_modules/.bin/tsx", "server/platform/main.ts"]
