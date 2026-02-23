# zk-verifier-core — Legacy Verification Library

**This crate is not deployed and is not used by the current HeistDuel deployment.**

## What it is

- A **library** (rlib) that provides:
  - **Proof blob parsing** — `parse_and_validate_proof_blob()`: validates the header `[4-byte total_fields][public_inputs][proof]` and supports specific proof field counts (424, 440, 456 — from the old **UltraHonk** format).
  - **Optional UltraHonk verification** — With the `real-verifier` feature, it can load a verification key from **JSON** and verify a proof using the `ultrahonk_soroban_verifier` crate (external path: `../ultrahonk-rust-verifier/ultrahonk-soroban-verifier`).

## Difference from zk-verifier

| | **zk-verifier** (contract) | **zk-verifier-core** (library) |
|--|----------------------------|---------------------------------|
| **Deployed** | Yes — this is the contract the heist calls | No — library only |
| **Proof system** | **Groth16** (BN254), implemented with Soroban host functions | **UltraHonk** (optional, via external crate) |
| **VK format** | Binary (set_vk with raw bytes) | JSON (array of hex strings) |
| **Proof format** | 292 bytes (n_pub + pi_hash + πA + πB + πC) | Variable (424/440/456 * 32-byte fields) |
| **Used by** | heist contract, deploy script | Nothing in the current build |

The current game uses **Groth16** (Circom/snarkjs) and the **zk-verifier** contract. The **zk-verifier-core** crate is legacy from the previous UltraHonk/Noir pipeline and is kept only for reference or a possible future UltraHonk-based circuit. It is **not** a dependency of `heist` or `zk-verifier`.

## When to use this crate

- If you reintroduce an **UltraHonk** verifier (e.g. Noir + Barretenberg) and want to share blob-parsing or verification logic.
- Otherwise, ignore it; all production verification goes through **zk-verifier**.
