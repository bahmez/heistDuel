# Contracts

This directory contains the two Soroban contracts used by HeistDuel:

- `heist`: game state machine (session lifecycle, turn submission, score updates, commitments).
- `zk-verifier`: Groth16 verifier wrapper that stores the verification key (VK) and validates proof blobs.

## Layout

```text
apps/contracts/
├── heist/                    # Main game contract
├── zk-verifier/              # Groth16 verifier contract
├── scripts/
│   ├── deploy.ts             # Main cross-platform deployment script
│   ├── seed-deployment.ts    # Firestore deployment sync helper
│   ├── deploy.ps1            # Legacy PowerShell deploy script
│   └── init-vk.ps1           # Legacy VK init helper
└── deployments/              # Generated deployment records
```

## Contract APIs (high level)

### `heist`

Main public methods include:

- `__constructor(admin, game_hub, verifier)`
- `start_game(...)`
- `reveal_seed(...)`
- `begin_match(session_id)`
- `submit_turn(session_id, player, proof_blob, public_turn)`
- `end_if_finished(session_id)`
- `get_game(session_id)`
- `get_state_commitment(session_id)`
- `get_expected_roll(session_id, player)`
- `compute_pi_hash(session_id, public_turn)`
- admin methods: `set_admin`, `set_hub`, `set_verifier`, `upgrade`

### `zk-verifier`

Main public methods include:

- `__constructor(admin)` / `initialize(admin)`
- `set_vk(vk: Bytes)` (admin only)
- `get_vk_hash()`
- `verify_proof_with_stored_vk(proof_blob: Bytes)`
- `is_verified(proof_id)`
- `upgrade(new_wasm_hash)`

## Build prerequisites

- Rust toolchain `1.90.0` recommended for Soroban compatibility.
- WASM target:
  - `rustup target add wasm32v1-none`
- Stellar CLI configured with your network and source account:
  - `stellar network ls`
  - `stellar keys ls`

## Build and test

From repository root:

```bash
pnpm build:contracts
pnpm test:contracts
```

Or directly with Cargo:

```bash
cd apps/contracts/heist
cargo test

cd ../zk-verifier
cargo test
```

## Deployment flow

The recommended deployment entry point is:

```bash
cd apps/contracts
pnpm deploy -- --network testnet --source <source> --game-hub <game-hub-contract-id>
```

This script:

1. Builds both contracts.
2. Deploys `zk-verifier`.
3. Deploys `heist` with the deployed verifier address.
4. Uploads VK (`set_vk`) to `zk-verifier` unless `--skip-vk` is used.
5. Writes deployment records to:
   - `apps/contracts/deployments/<network>.json`
   - Firestore (`deployments` collection) when Firebase is configured.

For script options and advanced modes (`--upgrade-heist-id`, `--update-vk-id`, `--skip-build`, `--vk-file`), see `apps/contracts/scripts/README.md`.

## Notes

- `deploy.ps1` is still available but considered legacy.
- The source of truth for runtime contract addresses is Firestore (plus deployment JSON as local fallback).
