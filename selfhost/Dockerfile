# syntax=docker/dockerfile:1.7
# Wickline Self-Hosted: the unmodified upstream app plus selfhost/, headless, no Electron.
# Build from the repository root:   docker build -f selfhost/Dockerfile -t wickline .

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only (undici); --ignore-scripts skips Electron's download entirely.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM node:${NODE_VERSION}-alpine AS runtime
ARG UPSTREAM_VERSION=unknown
ARG SELFHOST_REVISION=0
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="Wickline Self-Hosted (unofficial)" \
      org.opencontainers.image.description="Self-hosted edition of Wickline: sync across devices, background price alerts, single-user login." \
      org.opencontainers.image.source="https://github.com/mtrifan/wickline" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${UPSTREAM_VERSION}-sh.${SELFHOST_REVISION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      io.github.wickline.upstream-version="${UPSTREAM_VERSION}" \
      io.github.wickline.selfhost-revision="${SELFHOST_REVISION}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5173 \
    DATA_DIR=/data \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE server.mjs ./
COPY lib ./lib
COPY public ./public
COPY community ./community
COPY selfhost ./selfhost

# No package managers at runtime (smaller image, less attack surface). Unraid's nobody:users
# (99:100) by default; any UID works if /data is writable by it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown 99:100 /data
USER 99:100
VOLUME /data
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "selfhost/server.mjs"]
