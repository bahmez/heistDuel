FROM node:20-alpine AS build
WORKDIR /workspace
RUN corepack enable

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --filter web...

COPY apps/web apps/web
COPY packages/ui packages/ui
COPY packages/shared packages/shared

RUN pnpm --filter web... build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /workspace/apps/web/.next/standalone ./
COPY --from=build /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /workspace/apps/web/public ./apps/web/public

EXPOSE 8080
CMD ["node", "apps/web/server.js"]
