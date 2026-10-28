FROM node:24.21.0-bookworm-slim AS build

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/api/package.json packages/api/turbo.json packages/api/
COPY packages/binny/package.json packages/binny/turbo.json packages/binny/
COPY packages/contracts/package.json packages/contracts/turbo.json packages/contracts/
COPY packages/core/package.json packages/core/turbo.json packages/core/
COPY packages/db/package.json packages/db/turbo.json packages/db/
COPY packages/server/package.json packages/server/turbo.json packages/server/
COPY packages/tooling-config/package.json packages/tooling-config/

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec turbo run build --filter=@binny/server --filter=@binny/binny

FROM build AS runtime

RUN pnpm install --prod --offline --frozen-lockfile

EXPOSE 3000
CMD ["node", "packages/server/dist/index.js"]
