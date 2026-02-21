# HeistDuel

A zero-knowledge two-player heist strategy game built on Stellar/Soroban, submitted to the [Stellar Hacks: ZK Gaming hackathon](https://dorahacks.io/hackathon/stellar-hacks-zk-gaming/resources).

## Overview

Players compete to collect the most loot in a hidden map. The map layout, player positions, and moves are **never revealed on-chain** — only ZK proofs are submitted, proving that each turn is valid without revealing private game state.

### ZK Architecture

| Feature | Implementation |
|---|---|
| Hidden map | Double commit-reveal via backend relay |
| Provable randomness (dice) | Keccak256-based deterministic PRNG |
| Turn validity | Noir `turn_validity` circuit + UltraHonk proof |
| Fog-of-war | Position commitments (never stored in cleartext) |
| On-chain verification | `zk-verifier` Soroban contract |

### Project Structure

```
heistDuel/
├── apps/
│   ├── api/               # NestJS backend (lobby, relay, game coordination)
│   ├── circuits/
│   │   └── turn_validity/ # Noir ZK circuit (proves turn correctness)
│   ├── contracts/
│   │   ├── heist/         # Soroban game contract (Rust)
│   │   ├── zk-verifier/   # Soroban UltraHonk verifier contract (Rust)
│   │   └── scripts/
│   │       └── deploy.ts  # Deployment script
│   └── web/               # Next.js frontend
├── packages/
│   ├── stellar/           # TypeScript Stellar SDK client + engine
│   ├── database/          # Firestore data models
│   ├── firebase/          # Firebase admin helpers
│   ├── ui/                # Shared UI components
│   ├── shared/            # Shared types
│   └── storage/           # Storage helpers
└── target/                # Rust build output (WASM)
```

### Deployed contracts (Testnet)

| Contract | Address |
|---|---|
| `zk-verifier` | `CC5CI7GP2C2W452ZT23W7MV3D24LVTRTZFWGA55TBYQ4QZUL72SWAD64` |
| `heist` | `CAKBATWL2D56DCNH6XX2FETOJTBYZ2KQOGCIHR6BNJMQ57OEOQFLDHGJ` |

VK hash on-chain: `52934e9d1120f751931afe8dc03d32511ff0d5f3b85daf1eba4c54bcd44e6c7f`

---

## Prerequisites

### Node.js & Package Manager

- Node.js >= 20
- pnpm (`npm install -g pnpm`)

### Rust & Stellar CLI

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WASM target required by Soroban
rustup target add wasm32v1-none

# Install Rust toolchain 1.90.0 (required — newer versions are blacklisted by Stellar CLI)
rustup toolchain install 1.90.0
rustup target add wasm32v1-none --toolchain 1.90.0

# Install Stellar CLI
winget install stellar.stellar   # Windows
# or: cargo install --locked stellar-cli@22.7.1
```

### Configure Stellar network & identity

```bash
# Add testnet network
stellar network add testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

# Create a deployer identity (or import an existing key)
stellar keys generate heist-testnet-deployer --network testnet
stellar keys fund heist-testnet-deployer --network testnet   # faucet
```

### Noir & Barretenberg (for ZK circuit only)

These tools are only needed if you want to **recompile the circuit** or **regenerate the verification key**. The compiled circuit and VK are already committed.

**On Linux / WSL2 (Ubuntu 22.04+):**

```bash
# Install Nargo (Noir compiler) — version 1.0.0-beta.18 required
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
source ~/.nargo/env   # or restart shell
noirup                # installs latest stable nargo

# Install bbup (Barretenberg prover installer)
curl -sSL https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/cpp/installation/install | bash
```

**Install bb (Barretenberg) — requires Ubuntu 24.04 / GLIBC >= 2.39:**

Because the `bb` binary requires glibc 2.39, use Docker if your WSL is Ubuntu 22.04:

```bash
docker run --rm --memory=8g -v "$(pwd):/workspace" ubuntu:24.04 bash /workspace/docker_bb_setup.sh
```

Or, if you already have Ubuntu 24.04:

```bash
/root/.bb/bbup --version 3.0.0-nightly.20251104
# The correct tag format is v3.0.0-nightly.20251104 (no prefix)
# Asset: barretenberg-amd64-linux.tar.gz
```

> **Note**: The `bbup` installer script contains a bug — it tries to download from `aztec-packages-vX.Y.Z` (which does not exist). The correct tag is just `vX.Y.Z`. See the Docker workflow in [Compile the ZK circuit](#3-compile-the-zk-circuit-optional) below.

---

## Environment Variables

### `apps/api/.env`

```env
# Firebase / Firestore
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json

# Stellar
STELLAR_NETWORK=testnet
STELLAR_SOURCE_SECRET=SXXX...   # server-side signing key (for relay txs)
HEIST_CONTRACT_ID=CAKBATWL2D56DCNH6XX2FETOJTBYZ2KQOGCIHR6BNJMQ57OEOQFLDHGJ
```

### `apps/web/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_HEIST_CONTRACT_ID=CAKBATWL2D56DCNH6XX2FETOJTBYZ2KQOGCIHR6BNJMQ57OEOQFLDHGJ
```

---

## Running the project

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start all services (development)

```bash
pnpm dev
```

This runs (via Turborepo):
- `apps/api` — NestJS API on port 3001
- `apps/web` — Next.js frontend on port 3000

Or start individually:

```bash
# API only
cd apps/api && pnpm dev

# Frontend only
cd apps/web && pnpm dev
```

---

## Deploying the contracts

The deployment script `apps/contracts/scripts/deploy.ts` handles everything:
- Builds both Rust WASM contracts (using Rust toolchain 1.90.0)
- Deploys `zk-verifier`
- Deploys `heist` (passing the zk-verifier address to the constructor)
- Calls `set_vk` on `zk-verifier` with the UltraHonk verification key
- Writes the result to Firestore

### Full deploy (fresh)

```bash
cd apps/contracts
npx tsx scripts/deploy.ts --source heist-testnet-deployer
```

### Full deploy with explicit options

```bash
npx tsx scripts/deploy.ts \
  --network testnet \
  --source heist-testnet-deployer \
  --game-hub CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG \
  --vk-file ../circuits/turn_validity/target/vk
```

### Upgrade an existing `heist` contract (without redeploying verifier)

```bash
npx tsx scripts/deploy.ts \
  --source heist-testnet-deployer \
  --upgrade-heist-id CAKBATWL2D56DCNH6XX2FETOJTBYZ2KQOGCIHR6BNJMQ57OEOQFLDHGJ \
  --skip-vk
```

### Update the VK only (no redeploy)

Useful after recompiling the circuit:

```bash
npx tsx scripts/deploy.ts \
  --update-vk-id CC5CI7GP2C2W452ZT23W7MV3D24LVTRTZFWGA55TBYQ4QZUL72SWAD64 \
  --vk-file ../circuits/turn_validity/target/vk
```

### All `deploy.ts` options

| Option | Default | Description |
|---|---|---|
| `--network` | `testnet` | `testnet` or `mainnet` |
| `--source` | `heist-testnet-deployer` | Stellar identity alias or secret |
| `--game-hub` | (hardcoded default) | GameHub contract address |
| `--admin` | same as `--source` | Admin address for contracts |
| `--rust-toolchain` | `1.90.0` | Rust toolchain for Soroban build |
| `--skip-build` | `false` | Skip `cargo build` step |
| `--skip-vk` | `false` | Skip `set_vk` call on verifier |
| `--vk-file` | `apps/circuits/turn_validity/target/vk` | Path to VK binary (file or directory) |
| `--upgrade-heist-id` | — | Upgrade existing heist contract in-place |
| `--update-vk-id` | — | Update VK on existing verifier and exit |
| `--env-file` | `apps/api/.env` | `.env` file with Firebase credentials |

---

## ZK Circuit

### 3. Compile the ZK circuit (optional)

The compiled circuit (`target/turn_validity.json`) and the VK (`target/vk/`) are already committed. Only recompile if you modify `src/main.nr`.

**Requires**: Nargo 1.0.0-beta.18 (installed above via `noirup`), running in WSL/Linux.

```bash
# In WSL Ubuntu
cd apps/circuits/turn_validity
nargo compile
# Output: target/turn_validity.json (~1.3 MB)
```

### 4. Regenerate the Verification Key (optional)

The VK requires ~7 GB of RAM and Ubuntu 24.04 (GLIBC 2.39). Use Docker:

```bash
# From the repo root (Windows PowerShell or bash)
docker run --rm --memory=8g \
  -v "$(pwd):/workspace" \
  ubuntu:24.04 bash /workspace/docker_gen_vk.sh
```

Create `docker_gen_vk.sh` at the repo root:

```bash
#!/bin/bash
set -e
apt-get update -qq && apt-get install -y curl 2>&1 | tail -2

# Download bb matching nargo 1.0.0-beta.18
curl -fsSL \
  "https://github.com/AztecProtocol/aztec-packages/releases/download/v3.0.0-nightly.20251104/barretenberg-amd64-linux.tar.gz" \
  -o /root/bb.tar.gz
mkdir -p /root/.bb && cd /root/.bb && tar -xzf /root/bb.tar.gz && chmod +x ./bb

echo "bb version: $(/root/.bb/bb --version)"

/root/.bb/bb write_vk \
  -b /workspace/apps/circuits/turn_validity/target/turn_validity.json \
  -o /workspace/apps/circuits/turn_validity/target/vk

echo "VK generated at: apps/circuits/turn_validity/target/vk/"
ls -lh /workspace/apps/circuits/turn_validity/target/vk/
```

> **Important**: `bb write_vk` outputs a **directory** `vk/` containing two files:
> - `vk/vk` — the binary verification key (3680 bytes)
> - `vk/vk_hash` — the 32-byte hash of the VK
>
> The deploy script automatically reads `vk/vk` when given the directory path.

After generating the VK, upload it to the deployed verifier:

```bash
cd apps/contracts
npx tsx scripts/deploy.ts \
  --update-vk-id CC5CI7GP2C2W452ZT23W7MV3D24LVTRTZFWGA55TBYQ4QZUL72SWAD64
```

Then sync the current addresses to Firestore (the API reads from there):

```bash
npx tsx scripts/seed-deployment.ts
```

> `--update-vk-id` exits before the Firestore write. Run `seed-deployment.ts` whenever you update contracts or the VK outside of a full deploy.

---

## Running contract tests

```bash
# From repo root
pnpm test:contracts

# Or directly with cargo
cd apps/contracts/heist
cargo test

cd apps/contracts/zk-verifier
cargo test
```

> **Note**: Tests use Rust toolchain 1.90.0. If you get a Stellar CLI error about blacklisted versions, make sure `rustup toolchain install 1.90.0` has been run.

---

## Game Flow

```
Player 1                  Backend               Player 2
    |                        |                      |
    |-- createLobby -------->|                      |
    |   (mapSeedCommit,      |                      |
    |    mapSeedSecret)      |                      |
    |                        |<-- joinLobby --------|
    |                        |    (mapSeedCommit,   |
    |                        |     mapSeedSecret)   |
    |                        |                      |
    |    [on-chain: start_game with both seed commits]
    |                        |                      |
    |    [on-chain: reveal_seed — dice PRNG seeds]  |
    |                        |                      |
    |-- GET /map-secret ----->|                      |
    |<-- opponent's secret --|-- GET /map-secret ----|
    |                        |                      |
    | Both players derive map locally:              |
    |   map_seed = keccak(secret1 XOR secret2)      |
    |   map = generateMap(map_seed)                 |
    |                        |                      |
    |-- POST /begin-match -->|                      |
    |   (mapCommitment,      |                      |
    |    p1PosCommit,        |<-- POST /begin-match-|
    |    p2PosCommit)        |                      |
    |                        |                      |
    |    [on-chain: begin_match — stores commitments]
    |                        |                      |
    |    [Game loop: each turn]                     |
    |                        |                      |
    | Generate ZK proof (Noir circuit)              |
    | [on-chain: submit_turn(proof_blob, TurnZkPublic)]
```

---

## Key Design Decisions

### Why Keccak256 for commitments?

Soroban's `env.crypto().keccak256()` is natively available on-chain. Keccak256 is also supported as a black-box function in Noir via `std::hash::keccakf1600`, making it verifiable in both the contract and the ZK circuit.

> **Noir 1.0.0 note**: `std::hash::keccak256` was removed in Noir 1.0.0. The circuit implements Keccak-256 manually using `std::hash::keccakf1600` (the raw permutation), with proper padding and absorption.

### Why 80/160 iterations for map generation?

The circuit's constraint budget is limited by available RAM for VK generation (~7 GB required). The loop bounds were reduced from 500/1000 to **80/160** to keep the circuit compilable on typical hardware while still guaranteeing MAX_WALLS=18 and MAX_LOOT=24 placement for valid seeds. The TypeScript engine uses the same bounds.

### Why a backend relay for map secrets?

A pure on-chain commit-reveal would expose the map to on-chain observers. The backend acts as a temporary relay: it stores each player's map seed (hashed on-chain) and only reveals the opponent's secret after verifying the on-chain commitment. Secrets are deleted from the backend after `begin_match` is confirmed.

### Rust toolchain 1.90.0

The Stellar CLI `stellar contract build` blacklists certain Rust versions (`1.81`, `1.82`, `1.83`, `1.91.0`). Version `1.90.0` is a known-good version for building Soroban WASM contracts.
