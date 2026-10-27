# syntax=docker/dockerfile:1.7
# AISlopMediaBox — one container, zero cloud, all slop.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --foreground-scripts \
  && npm rebuild better-sqlite3 --foreground-scripts

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title="AISlopMediaBox" \
      org.opencontainers.image.description="Certified self-hosted slop: movies, shows, music, photos, admin chaos." \
      org.opencontainers.image.source="https://github.com/horatio42/AISlopMediaBox" \
      org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg fonts-dejavu-core tini gosu ca-certificates \
    libva2 libva-drm2 mesa-va-drivers \
  && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
       apt-get install -y --no-install-recommends intel-media-va-driver; \
     fi \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /app \
  && chown node:node /data

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    MEDIA_DIR=/data/media \
    PORT=3100 \
    HOST=0.0.0.0 \
    SEED_DEMO=1 \
    DEMO_MODE=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && chown -R node:node /app

VOLUME ["/data"]
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.ts"]
