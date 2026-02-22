# Contract Scripts

This folder contains deployment and deployment-sync utilities for Soroban contracts.

## Scripts

### `deploy.ts` (recommended)

Cross-platform deployment script used by default.

- Builds `zk-verifier` and `heist` (unless `--skip-build`).
- Deploys both contracts, or upgrades an existing `heist` contract.
- Uploads Groth16 VK to `zk-verifier` (unless `--skip-vk`).
- Writes outputs to JSON and Firestore.
- Updates local `.env` files and shared constants for convenience.

Run from `apps/contracts`:

```bash
pnpm deploy -- --network testnet --source <source> --game-hub <game-hub-id>
```

### `seed-deployment.ts`

Writes a deployment record to Firestore when contracts were deployed/updated manually.

```bash
npx tsx scripts/seed-deployment.ts --network testnet
```

### `deploy.ps1` (legacy)

PowerShell deployment script retained for compatibility. Prefer `deploy.ts` for new workflows.

### `init-vk.ps1` (legacy)

Helper script for VK initialization in older workflows.

## `deploy.ts` options

| Option | Default | Description |
|---|---|---|
| `--network` | `testnet` | Target network (`testnet` or `mainnet`) |
| `--source` | `heist-testnet-deployer` | Stellar key alias or secret used to sign txs |
| `--game-hub` | built-in default | GameHub contract ID |
| `--admin` | source address | Admin address for contract constructors |
| `--rust-toolchain` | `1.90.0` | Rust toolchain used for `stellar contract build` |
| `--skip-build` | `false` | Skip Rust build and reuse existing WASM artifacts |
| `--skip-vk` | `false` | Skip `set_vk` call on `zk-verifier` |
| `--vk-file` | `apps/circuits/turn_validity_g16/build/vk.bin` | VK binary file (or directory containing `vk.bin`) |
| `--upgrade-heist-id` | empty | Upgrade an existing heist contract in-place |
| `--update-vk-id` | empty | Update VK on an existing verifier and exit |
| `--env-file` | `apps/api/.env` | Extra env file (Firebase credentials/config) |

## VK source resolution

`deploy.ts` resolves VK in this order:

1. `--vk-file` value (if provided)
2. `apps/circuits/turn_validity_g16/build/vk.bin`
3. Placeholder bytes (for local/dev fallback, with warning logs)

Generate a real VK from the circuit workspace:

```bash
cd apps/circuits/turn_validity_g16
npm install
npm run compile
npm run setup
```

## Outputs

### Local JSON record

- `apps/contracts/deployments/<network>.json`

Contains addresses, VK hash, mode (`full` / `upgrade`), and metadata.

### Firestore record (if configured)

- Collection: `deployments`
- Document ID: deployment timestamp (`ISO8601`)

The API loads active addresses from these deployment records on restart.
