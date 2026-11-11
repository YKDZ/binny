FROM node:26.13.0-bookworm-slim AS build

# Install the same native pnpm release that packageManager declares.
COPY --from=ghcr.io/pnpm/pnpm:12.9.1 /opt/pnpm /opt/pnpm
RUN for bin in pnpm pn pnpx pnx; do ln -s /opt/pnpm/pnpm "/usr/local/bin/$bin"; done
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/turbo.json apps/cli/
COPY packages/api/package.json packages/api/turbo.json packages/api/
COPY packages/contracts/package.json packages/contracts/turbo.json packages/contracts/
COPY packages/core/package.json packages/core/turbo.json packages/core/
COPY packages/db/package.json packages/db/turbo.json packages/db/
COPY packages/server/package.json packages/server/turbo.json packages/server/
COPY packages/tooling-config/package.json packages/tooling-config/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec turbo run build --filter=@binny/server --filter=@ykdz/binny

FROM build AS runtime

RUN pnpm install --prod --offline --frozen-lockfile

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
