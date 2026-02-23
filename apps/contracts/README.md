# Contracts

Soroban smart contracts for HeistDuel. Two contracts are built and deployed:

| Contract | Role |
|----------|------|
| **heist** | Game state machine: session lifecycle, turn submission (with ZK proof verification), score updates, commitments, chess clock, exit handling. |
| **zk-verifier** | Groth16 (BN254) verifier: stores the verification key (VK) and validates proof blobs for turn validity. |

A third crate, **zk-verifier-core**, is a legacy library for the old UltraHonk proof system and is **not** used by the current deployment. See [zk-verifier-core/README.md](zk-verifier-core/README.md) for the difference between `zk-verifier` and `zk-verifier-core`.

## Layout

```text
apps/contracts/
├── heist/                    # Main game contract
├── zk-verifier/              # Groth16 verifier (deployed)
├── zk-verifier-core/         # Legacy UltraHonk lib (not deployed)
├── scripts/
│   ├── deploy.ts             # Main cross-platform deployment script
│   ├── seed-deployment.ts    # Firestore deployment sync helper
│   ├── deploy.ps1            # Legacy PowerShell deploy script
│   └── init-vk.ps1           # Legacy VK init helper
└── deployments/              # Generated deployment records (JSON)
```

## Contract APIs (high level)

### heist

- **Lifecycle**: `__constructor(admin, game_hub, verifier)`, `start_game(...)`, `reveal_seed(...)`, `begin_match(session_id)`
- **Turns**: `submit_turn(session_id, player, proof_blob, public_turn)`, `pass_turn(session_id)`
- **End**: `end_if_finished(session_id)`
- **Views**: `get_game(session_id)`, `get_state_commitment(session_id)`, `get_expected_roll(session_id, player)`
- **Admin**: `set_admin`, `set_hub`, `set_verifier`, `upgrade`

See [heist/README.md](heist/README.md) for details.

### zk-verifier

- **Init**: `__constructor(admin)` / `initialize(admin)`
- **VK**: `set_vk(vk: Bytes)` (admin), `get_vk_hash()`
- **Proof**: `verify_proof_with_stored_vk(proof_blob: Bytes)` → returns `proof_id` (keccak256 of blob)
- **State**: `is_verified(proof_id)`
- **Admin**: `upgrade(new_wasm_hash)`

See [zk-verifier/README.md](zk-verifier/README.md) for proof/VK formats.

## Build prerequisites

- Rust toolchain **1.90.0** (recommended for Soroban compatibility).
- WASM target: `rustup target add wasm32v1-none`
- Stellar CLI configured: `stellar network ls`, `stellar keys ls`

## Build and test

From repository root:

```bash
pnpm build:contracts
pnpm test:contracts
```

Or with Cargo from `apps/contracts`:

```bash
cd heist && cargo test
cd ../zk-verifier && cargo test
```

## Deployment

From `apps/contracts`:

```bash
pnpm deploy -- --network testnet --source <source> --game-hub <game-hub-contract-id>
```

The script:

1. Builds `zk-verifier` and `heist`.
2. Deploys `zk-verifier`, then `heist` with the verifier address.
3. Uploads the Groth16 VK to `zk-verifier` (from `apps/circuits/turn_validity_g16/build/vk.bin`) unless `--skip-vk`.
4. Writes deployment records to `deployments/<network>.json` and optionally Firestore.

Options (e.g. `--upgrade-heist-id`, `--update-vk-id`, `--skip-build`, `--vk-file`): see [scripts/README.md](scripts/README.md).

## Notes

- `deploy.ps1` and `init-vk.ps1` are legacy; prefer `deploy.ts`.
- Runtime contract addresses are stored in Firestore (and in local `deployments/*.json` as fallback).
