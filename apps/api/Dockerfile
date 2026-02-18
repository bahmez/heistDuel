FROM node:20-bookworm-slim AS base
WORKDIR /workspace
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/firebase/package.json packages/firebase/
COPY packages/shared/package.json packages/shared/
COPY packages/stellar/package.json packages/stellar/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/api apps/api
COPY packages/database packages/database
COPY packages/firebase packages/firebase
COPY packages/shared packages/shared
COPY packages/stellar packages/stellar
RUN pnpm --filter @repo/api... build

FROM node:20-bookworm-slim AS runtime
WORKDIR /workspace
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/apps/api/dist ./apps/api/dist
COPY --from=build /workspace/apps/api/package.json ./apps/api/package.json
COPY --from=build /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/package.json ./package.json

EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
