# Circuits

This directory contains ZK circuit assets used by HeistDuel.

## Directory map

```text
apps/circuits/
├── turn_validity_g16/   # Active Circom + Groth16 pipeline (used in production flow)
└── turn_validity/       # Legacy Noir artifacts kept for reference/migration history
```

## Active circuit: `turn_validity_g16`

The active proving system is Groth16 on BN254 with Poseidon-based commitments.

Main files:

- `turn_validity_g16/turn_validity.circom`: turn validity circuit.
- `turn_validity_g16/scripts/setup.mjs`: trusted setup + VK export.
- `turn_validity_g16/scripts/prove.mjs`: local proof generation helper.
- `turn_validity_g16/build/vk.bin`: binary VK uploaded on-chain.

Typical workflow:

```bash
cd apps/circuits/turn_validity_g16
npm install
npm run compile
npm run setup
```

Generated artifacts include:

- `build/turn_validity.r1cs`
- `build/turn_validity_js/turn_validity.wasm`
- `build/turn_validity_final.zkey`
- `build/vk.json`
- `build/vk.bin`

## VK and proof encoding notes

- VK binary and proof blob encoding are aligned with Soroban BN254 host expectations.
- G2 Fp2 elements are serialized in EIP-197 order (`c1 || c0`, big-endian limbs).
- Keep setup/export scripts and backend proof packing in sync whenever encoding logic changes.

## Legacy directory: `turn_validity`

`turn_validity` contains older Noir-based artifacts from previous iterations.
It is not the default pipeline for current deployments.

If you keep it for historical context, ensure deployment and backend paths still target
`turn_validity_g16` artifacts (`build/vk.bin`, Groth16 witness/proof flow).
