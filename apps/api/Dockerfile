FROM node:20-alpine AS runtime
WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/firebase/package.json packages/firebase/
COPY packages/llm/package.json packages/llm/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/

RUN pnpm install --filter @repo/api...

COPY apps/api apps/api
COPY packages packages

RUN pnpm --filter @repo/api... build

WORKDIR /workspace/apps/api
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["pnpm", "start"]
