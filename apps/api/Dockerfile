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
# Include Groth16 circuit artifacts used by ProofService at runtime.
# These are generated in apps/circuits/turn_validity_g16/ via:
#   npm run compile  -> turn_validity_js/turn_validity.wasm
#   npm run setup    -> turn_validity_final.zkey
COPY apps/circuits/turn_validity_g16/build/turn_validity_js/turn_validity.wasm apps/circuits/turn_validity_g16/build/turn_validity_js/turn_validity.wasm
COPY apps/circuits/turn_validity_g16/build/turn_validity_final.zkey apps/circuits/turn_validity_g16/build/turn_validity_final.zkey
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
# Groth16 artifacts needed at runtime for proof generation
COPY --from=build /workspace/apps/circuits/turn_validity_g16/build/turn_validity_js/turn_validity.wasm ./apps/circuits/turn_validity_g16/build/turn_validity_js/turn_validity.wasm
COPY --from=build /workspace/apps/circuits/turn_validity_g16/build/turn_validity_final.zkey ./apps/circuits/turn_validity_g16/build/turn_validity_final.zkey

EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
