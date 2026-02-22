# Legacy Noir Circuit (Deprecated)

This directory previously contained the Noir-based turn validity circuit and its generated artifacts.

It is kept only as a migration marker. The active proving pipeline is now:

- `apps/circuits/turn_validity_g16/`
- Circom + Groth16 on BN254
- Soroban verifier integration via compact Groth16 VK/proof formats

## Why we moved to Groth16

The project migrated from the Noir/UltraHonk path to Groth16 to better fit the current on-chain verification constraints and runtime workflow:

- Smaller verifier footprint on Soroban (critical for contract size limits)
- Cleaner compatibility with BN254 host operations
- Simpler, explicit VK/proof serialization shared across backend and contract
- Faster and more predictable proof integration in the API runtime

## Current source of truth

For circuit changes, setup, and artifact generation, use only:

- `apps/circuits/turn_validity_g16/README.md`
- `apps/circuits/README.md`

Do not add new artifacts to this legacy folder.
