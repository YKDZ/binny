FROM node:26.13.0-bookworm-slim AS build

# Keep the package manager version aligned with the repository lockfile.
COPY --from=ghcr.io/pnpm/pnpm:12.9.1 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s /opt/pnpm/pnpm "/usr/local/bin/$bin"; done
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,id=binny-pnpm-v12,target=/pnpm/store,sharing=locked \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store \
    --filter @binny/source-adapter-qwen... --filter '!binny'
RUN pnpm --filter @binny/source-adapter-qwen... build \
  && pnpm --filter @binny/source-adapter-qwen --prod deploy --config.allow-unused-patches=true /adapter-deploy

FROM binny/source-adapter-runtime:lightweight-v1

ENV BINNY_SOURCE_ADAPTER_ENTRY=/app/adapter/dist/index.js
WORKDIR /app
COPY --from=build --chown=node:node /adapter-deploy /app/adapter
USER node
