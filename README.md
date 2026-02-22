# HeistDuel

HeistDuel is a two-player strategy game on Stellar/Soroban where turn validity is proven with zero-knowledge proofs.  
Players keep map details and exact movement private while the contracts enforce valid state transitions.

## Architecture

| Layer | Responsibility |
|---|---|
| `apps/web` | Game UI and client-side turn building |
| `apps/api` | Match coordination, proof generation endpoint, deployment lookup |
| `apps/contracts/heist` | Main game contract (sessions, turns, commitments, scoring) |
| `apps/contracts/zk-verifier` | Groth16 verifier contract + stored VK |
| `apps/circuits/turn_validity_g16` | Active Circom Groth16 circuit pipeline |
| `packages/stellar` | Shared game engine, contract client, hashing helpers |

## Project structure

```text
heistDuel/
├── apps/
│   ├── api/
│   ├── web/
│   ├── circuits/
│   │   ├── README.md
│   │   ├── turn_validity_g16/   # active circuit pipeline
│   │   └── turn_validity/       # legacy noir artifacts
│   └── contracts/
│       ├── README.md
│       ├── heist/
│       ├── zk-verifier/
│       └── scripts/
├── packages/
└── target/                      # Rust/Soroban build output
```

## Requirements

- Node.js `>=20`
- `pnpm` (`npm i -g pnpm`)
- Rust + Soroban target:
  - `rustup toolchain install 1.90.0`
  - `rustup target add wasm32v1-none --toolchain 1.90.0`
- Stellar CLI configured with your network and keys

Optional (only when regenerating circuit artifacts):

- Circom runtime for `turn_validity_g16` compilation
- `snarkjs` is installed in the circuit workspace via `npm install`

## Environment variables

### `apps/api/.env`

```env
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json

STELLAR_NETWORK=testnet
STELLAR_SOURCE_SECRET=S...
HEIST_CONTRACT_ID=C...
ZK_VERIFIER_CONTRACT_ID=C...
```

### `apps/web/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_HEIST_CONTRACT_ID=C...
NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID=C...
NEXT_PUBLIC_VK_HASH=...
```

## Local development

Install dependencies:

```bash
pnpm install
```

Run all apps:

```bash
pnpm dev
```

Or run independently:

```bash
pnpm --filter @repo/api dev
pnpm --filter @repo/web dev
```

## Circuit workflow (Groth16)

From `apps/circuits/turn_validity_g16`:

```bash
npm install
npm run compile
npm run setup
```

This generates/refreshes:

- `build/turn_validity.r1cs`
- `build/turn_validity_js/turn_validity.wasm`
- `build/turn_validity_final.zkey`
- `build/vk.json`
- `build/vk.bin`

`vk.bin` is the file uploaded to the on-chain verifier (`set_vk`).

## Contracts deployment

Recommended path (cross-platform TypeScript script):

```bash
cd apps/contracts
pnpm deploy -- --network testnet --source <source> --game-hub <game-hub-id>
```

Useful modes:

- Full deploy: deploy both contracts + set VK
- Heist upgrade only: `--upgrade-heist-id <C...>`
- VK update only: `--update-vk-id <C...> --vk-file <path-to-vk.bin>`

Deployment outputs:

- `apps/contracts/deployments/<network>.json`
- Firestore `deployments` collection (if Firebase is configured)

## Testing

```bash
pnpm test
pnpm test:contracts
```

## Additional docs

- Circuit docs: `apps/circuits/README.md`
- Contract docs: `apps/contracts/README.md`
- Script docs: `apps/contracts/scripts/README.md`
