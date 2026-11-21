# syntax=docker/dockerfile:1.7

FROM node-bookworm-slim AS build

COPY --from=pnpm-release /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s /opt/pnpm/pnpm "/usr/local/bin/$bin"; done
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @binny/source-adapter-linuxdo... build \
  && pnpm --filter @binny/source-adapter-linuxdo --prod deploy --config.allow-unused-patches=true /linuxdo-deploy \
  && test -f /linuxdo-deploy/dist/index.js

FROM binny/source-adapter-runtime:browser-v1

ENV BINNY_SOURCE_ADAPTER_ENTRY=/app/linuxdo/dist/index.js
WORKDIR /app/binny-runtime
COPY --from=build --chown=node:node /linuxdo-deploy /app/linuxdo
