# syntax=docker/dockerfile:1.7

FROM node:26.13.0-bookworm-slim AS build

COPY --from=ghcr.io/pnpm/pnpm:12.9.1 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s /opt/pnpm/pnpm "/usr/local/bin/$bin"; done
WORKDIR /workspace
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @binny/source-adapter-browser-session-fixture... build \
  && pnpm --filter @binny/source-adapter-browser-session-fixture --prod deploy --config.allow-unused-patches=true /browser-session-fixture-deploy \
  && test -f /browser-session-fixture-deploy/dist/index.js

FROM binny/source-adapter-runtime:browser-v1

ENV BINNY_SOURCE_ADAPTER_ENTRY=/app/browser-session-fixture/dist/index.js
WORKDIR /app/binny-runtime
COPY --from=build --chown=node:node /browser-session-fixture-deploy /app/browser-session-fixture
