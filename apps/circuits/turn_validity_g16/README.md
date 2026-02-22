# Turn Validity Circuit (Groth16)

This workspace contains the active HeistDuel turn-validity circuit:

- **Circuit language**: Circom
- **Proof system**: Groth16
- **Curve**: BN254
- **Hash inside circuit**: Poseidon

## What the circuit proves

Given private map and movement inputs, the circuit proves:

1. `pos_commit_before = Poseidon3(pos_x, pos_y, pos_nonce)`
2. Path validity (bounds, adjacency, no wall crossing)
3. `loot_delta` consistency with the traversed cells
4. `pos_commit_after = Poseidon3(end_x, end_y, new_pos_nonce)`
5. `pi_hash` consistency with the public turn data

The public signal is `pi_hash` (single public input in Groth16 verification).

## Quick start

```bash
cd apps/circuits/turn_validity_g16
npm install
npm run compile
npm run setup
```

`npm run compile` generates:

- `build/turn_validity.r1cs`
- `build/turn_validity_js/turn_validity.wasm`
- `build/turn_validity.sym`

`npm run setup` generates:

- `build/turn_validity_final.zkey`
- `build/vk.json`
- `build/vk.bin`

## Using generated artifacts

Deployment script `apps/contracts/scripts/deploy.ts` reads `build/vk.bin` by default and calls `set_vk` on `zk-verifier`.

The backend proof service uses:

- circuit WASM: `build/turn_validity_js/turn_validity.wasm`
- proving key: `build/turn_validity_final.zkey`

## Encoding compatibility (important)

For Soroban BN254 host compatibility:

- G1 elements use standard 32-byte big-endian limbs (`x || y`).
- G2 Fp2 elements are encoded in EIP-197 order (`c1 || c0`) per coordinate.

This ordering must remain consistent across:

- VK export (`scripts/setup.mjs`)
- Proof blob packing (backend API)
- On-chain verifier parsing

## Binary formats

### VK binary (`vk.bin`)

Current format is 580 bytes (for 1 public input):

```text
[  0.. 64] alpha_g1
[ 64..192] beta_g2
[192..320] gamma_g2
[320..448] delta_g2
[448..452] n_ic (u32 BE)
[452..516] IC[0]
[516..580] IC[1]
```

### Proof blob

Current format is 292 bytes:

```text
[  0..  4] n_pub (u32 BE, expected 1)
[  4.. 36] pi_hash (public input)
[ 36..100] pi_a (G1)
[100..228] pi_b (G2)
[228..292] pi_c (G1)
```
