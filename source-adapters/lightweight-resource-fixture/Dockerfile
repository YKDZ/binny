FROM node-bookworm-slim AS build

COPY --from=pnpm-release /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s /opt/pnpm/pnpm "/usr/local/bin/$bin"; done
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,id=binny-pnpm-v12,target=/pnpm/store,sharing=locked \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    --filter @binny/source-adapter-lightweight-resource-fixture... --filter '!binny'
RUN pnpm --filter @binny/source-adapter-lightweight-resource-fixture... build \
  && pnpm --filter @binny/source-adapter-lightweight-resource-fixture --prod deploy --config.allow-unused-patches=true /adapter-deploy

FROM binny/source-adapter-runtime:lightweight-v1

ENV BINNY_SOURCE_ADAPTER_ENTRY=/app/adapter/dist/index.js
WORKDIR /app
COPY --from=build --chown=node:node /adapter-deploy /app/adapter
USER node
