# HeistDuel — Zero-Knowledge Design Document

## The Core Idea

HeistDuel is a two-player heist strategy game where **nothing about the game state is visible on-chain**: not the map layout, not the players' positions, not the path they took during a turn. Yet every turn is cryptographically proven to be valid.

This is possible because every move is backed by a **ZK proof** (UltraHonk via Noir) that attests to the correctness of the move without revealing the private details. The blockchain only stores cryptographic commitments and verified proof identifiers — never raw game data.

---

## ZK Properties by Feature

### 1. Hidden Map (Commit-Reveal + ZK)

**Problem**: If the game map (walls, loot, cameras, lasers) is stored on-chain, any observer can read it and play with complete information. That breaks the asymmetry of information that makes the game interesting.

**Solution — Double commit-reveal with backend relay:**

Each player commits to a private 32-byte map seed **before** the game starts:

```
start_game(
    p1_map_seed_commit = keccak256(secret_1),
    p2_map_seed_commit = keccak256(secret_2),
)
```

The secrets are never posted on-chain. Instead:

1. Each player sends their raw secret to the backend.
2. The backend verifies `keccak(secret_i) == pN_map_seed_commit` (checking against the on-chain commitment).
3. The backend cross-relays: P1 receives `secret_2`, P2 receives `secret_1`.
4. Each player independently computes:
   ```
   map_seed = keccak256(secret_1 XOR secret_2)
   map      = generateMap(map_seed)
   map_commitment = keccak256(serialize(map))
   ```
5. Both players sign `begin_match(map_commitment, p1_pos_commit, p2_pos_commit)`.

The on-chain contract stores only `map_commitment`. No observer can reverse this commitment to learn the map. Neither player can use a different map — the ZK proof in each turn re-derives the map from the secrets and verifies that `keccak(generate_map(map_seed)) == map_commitment`.

**ZK guarantee**: The circuit proves that:
- `keccak(map_secret_1) == p1_map_seed_commit` (on-chain)
- `keccak(map_secret_2) == p2_map_seed_commit` (on-chain)
- `map_seed = keccak(secret_1 XOR secret_2)`
- `keccak(serialize(generate_map(map_seed))) == map_commitment` (on-chain)

This means the map used during the game is **cryptographically tied** to the on-chain commitments, without ever being revealed.

---

### 2. Provable Randomness (Dice Rolls)

**Problem**: If dice rolls rely on a server or on `env.prng()` (Soroban's non-deterministic PRNG), neither player can independently verify the fairness of the roll, and the formula cannot be reproduced inside a ZK circuit.

**Solution — Keccak256 deterministic PRNG:**

```rust
// Rust (on-chain & off-chain client)
roll = keccak256(session_seed ‖ turn_index ‖ player_tag)[0] % 6 + 1
```

```noir
// Noir circuit
fn roll_value(session_seed, turn_index, player_tag) -> u32 {
    let h = keccak256_40(buf);
    (h[0] as u32) % 6 + 1
}
```

The `session_seed` is derived from both players' revealed seeds (via commit-reveal), so neither player controls it:

```rust
session_seed = keccak256(session_id ‖ seed_1 ‖ seed_2)
```

**ZK guarantee**: The circuit verifies that `path_len <= rolled_value`. A player cannot claim to have moved more steps than the dice allowed. The dice computation is deterministic and verifiable by anyone who knows `session_seed` and `turn_index` — both of which become public after `begin_match`.

**Properties:**
- **Non-manipulable**: Neither player controls `session_seed` alone.
- **Verifiable**: Any third party can recompute the roll from public data.
- **ZK-compatible**: Pure Keccak — no randomness oracle or server required.

---

### 3. Private Position / Fog-of-War

**Problem**: Storing coordinates on-chain reveals exactly where each player is, eliminating any strategic element of positioning.

**Solution — Position commitments with private nonces:**

Position is never stored in cleartext. Instead:

```
pos_commit = keccak256(x ‖ y ‖ nonce)
```

The `nonce` is a private 32-byte value only the player knows. The on-chain contract stores only `pos_commit`. Nobody can determine the actual position (x, y) without knowing the nonce.

The nonce rotates every turn:

```noir
// In circuit
new_pos_nonce = keccak256(pos_nonce ‖ turn_index_BE)
pos_commit_after = keccak256(end_x ‖ end_y ‖ new_pos_nonce)
```

**ZK guarantee**: The circuit proves:
- `pos_commit_before = keccak(pos_x, pos_y, pos_nonce)` — the player actually started where they claimed.
- `pos_commit_after = keccak(end_x, end_y, new_pos_nonce)` — the player ended at a position reachable from their start given the path.
- `new_pos_nonce = keccak(pos_nonce ‖ turn_index)` — the nonce rotation is deterministic and non-replayable.

This implements **fog-of-war**: both players see only commitment values on-chain, not coordinates.

---

### 4. Turn Validity (Private Path + ZK Proof)

**Problem**: How can the blockchain accept a score update without knowing the path the player took, which walls they passed, or which loot they collected?

**Solution — The `turn_validity` Noir circuit:**

Every turn, the player generates a ZK proof locally. The circuit takes **private inputs** (map secrets, position, path, nonces) and **proves public outputs** (score_delta, loot_delta, pos_commit_after) are correctly derived.

Specifically, the circuit asserts:

| Step | What is proven | Private data used |
|---|---|---|
| 1 | pi_hash binds all claimed public outputs | — |
| 2 | Map seed commitments match secrets | `map_secret_1`, `map_secret_2` |
| 3 | Map is correctly generated from seeds | Both secrets |
| 4 | map_commitment matches generated map | Serialized map |
| 5 | pos_commit_before is valid | `pos_x`, `pos_y`, `pos_nonce` |
| 6 | Dice roll allows the path length | `session_seed` |
| 7 | path_len == 0 when no_path_flag is set | `path_x`, `path_y` |
| 8 | Path starts at current position | `pos_x`, `pos_y` |
| 9 | Each step is adjacent, in-bounds, no wall | Full path + wall bitset |
| 10 | loot_delta is correctly counted | Loot bitset + path |
| 11 | camera_hits, laser_hits are correct | Camera/laser positions + path |
| 12 | score_delta = loot - cameras - 2×lasers | All of the above |
| 13 | new_pos_nonce is correctly derived | `pos_nonce`, `turn_index` |
| 14 | pos_commit_after = keccak(end_x, end_y, new_nonce) | New position + nonce |

**On-chain verification flow:**

```
submit_turn(session_id, player, proof_blob, TurnZkPublic)
  ├── Verify player is active player
  ├── Verify pos_commit_before == stored pos_commit (on-chain)
  ├── Verify state_commit_before == stored state_commitment (on-chain)
  ├── Compute expected pi_hash from TurnZkPublic fields
  ├── Verify proof_blob[4..36] == expected pi_hash
  ├── Call ZkVerifier.verify_proof_with_stored_vk(proof_blob)  ← UltraHonk
  └── Apply proven state: update score, pos_commit, loot_count, state_commitment
```

**Key design**: Only one public input reaches the verifier — `pi_hash`, a Keccak256 hash of all claimed public turn data. This collapses the entire turn output into a single field element, keeping on-chain verification cost minimal while binding all outputs to the proof.

---

### 5. State Chain (Anti-Replay / Turn Ordering)

Each turn's proof includes `state_commit_before` and `state_commit_after`. The on-chain contract enforces:

```rust
assert(public_turn.state_commit_before == game.state_commitment)
```

After a successful turn:

```rust
game.state_commitment = state_commit_after
```

This creates a **cryptographic chain** between turns — like a blockchain within the game. A turn's proof is only valid if the prover knows the exact state commitment produced by the previous turn. This prevents:
- **Replay attacks**: old proofs cannot be resubmitted (state_commit_before won't match)
- **Out-of-order turns**: proofs must be submitted in sequence
- **Turn skipping**: every transition must be proven

---

## What Is and Isn't Revealed On-Chain

| Data | On-chain | Off-chain / Private |
|---|---|---|
| Player addresses | ✅ public | — |
| Scores (cumulative) | ✅ public | — |
| Turn index | ✅ public | — |
| Active player | ✅ public | — |
| Map commitment | ✅ public | Map layout ❌ |
| Map seed commits | ✅ public | Both secrets ❌ |
| Position commitments | ✅ public | x, y, nonces ❌ |
| State commitment | ✅ public | Derivation details ❌ |
| Loot count (total) | ✅ public | Which cells ❌ |
| Proof identifier (hash) | ✅ public | Proof bytes (only submitter needs) |
| Session seed | ✅ public (after begin_match) | — |
| Path taken | ❌ never | Player only |
| Hazard hits breakdown | ❌ never | Player only |

---

## Remaining Improvements

### 1. Frontend proof generation (critical for full playability)

**Current state**: The Noir circuit (`apps/circuits/turn_validity`) is compiled and the verification key is deployed on-chain. The TypeScript client (`packages/stellar/src/engine.ts`) has all commitment computation helpers. However, the frontend (`apps/web`) does not yet integrate `@noir-lang/noir_js` and `@aztec/bb.js` to actually generate proofs in-browser.

**Impact**: Without proof generation, the game loop cannot complete. Players can commit to seeds and begin a match, but `submit_turn` will fail without a valid proof.

**Fix**:
```typescript
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import circuit from '../circuits/turn_validity/target/turn_validity.json';

async function generateTurnProof(privateInputs: TurnPrivateInputs) {
    const backend = new UltraHonkBackend(circuit.bytecode);
    const noir = new Noir(circuit);

    const { witness } = await noir.execute(privateInputs);
    const { proof, publicInputs } = await backend.generateProof(witness);
    return wrapProofBlob(proof, publicInputs[0]); // pi_hash
}
```

Note: Proof generation for this circuit takes several minutes due to its size (80 wall + 160 loot Keccak iterations). For production, this should be offloaded to a backend worker. For the demo, a pre-generated proof can illustrate the flow.

---

### 2. Backend relay trust model

**Current state**: The backend verifies map secret commitments against on-chain values before relaying. However, the backend is a **trusted relay** — it sees both players' raw map secrets temporarily.

**Mitigation already in place**:
- Secrets are deleted from the backend database immediately after `begin_match` is confirmed.
- The backend verifies `keccak(secret_i) == pN_map_seed_commit` before relaying.
- Players can verify their opponent's secret locally after receiving it.

**Theoretical improvement**: Eliminate the trusted backend entirely using on-chain encrypted channels (e.g., ECIES with player public keys). Each player encrypts their secret with the opponent's public key and posts it on-chain. The opponent decrypts locally. This removes the backend from the trust model entirely but requires additional on-chain storage and player key management.

---

## Technical Stack

| Layer | Technology | Purpose |
|---|---|---|
| ZK Circuit | Noir 1.0.0-beta.18 | Turn validity proof (private path, map, positions) |
| Proof System | UltraHonk (Barretenberg 3.0.0-nightly) | Proof generation + on-chain verification |
| Smart Contracts | Soroban/Rust (soroban-sdk 22.0.7) | On-chain state, commitment verification |
| Hash Function | Keccak-256 | Commitments + PRNG (available in Soroban & Noir) |
| Backend | NestJS | Map secret relay, lobby coordination |
| Frontend | Next.js + Stellar Wallets Kit | Player interface, commitment computation |
| Blockchain | Stellar Testnet | Contract hosting, GameHub integration |

---

## Summary

HeistDuel uses ZK proofs as the **only way** to advance the game state. There is no server-side validation of moves, no trust in any off-chain authority for turn correctness, and no on-chain data that reveals the map or player positions. The ZK proof is not an add-on — it is the game's enforcement mechanism.

The commitment chain, combined with the double commit-reveal for map generation, ensures that:
- The map cannot be fabricated or modified mid-game
- Positions cannot be teleported
- Dice rolls cannot be manipulated
- Score calculations cannot be falsified (`score_delta` byte consistency is now proven in-circuit)

This makes HeistDuel a **genuinely private two-player game with verifiable outcomes** - a player wins because they collected more loot while avoiding hazards, and that fact is cryptographically proven, not asserted.
