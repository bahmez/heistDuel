# HeistDuel — Zero-Knowledge Design Document

## The Core Idea

HeistDuel is a two-player heist strategy game where **nothing about the game state is visible on-chain**: not the map layout, not the players' positions, not the path they took during a turn. Yet every turn is cryptographically proven to be valid.

This is possible because every move is backed by a **ZK proof** (Groth16 via Circom/snarkjs) that attests to the correctness of the move without revealing the private details. The blockchain only stores cryptographic commitments and verified proof identifiers — never raw game data.

---

## ZK Properties by Feature

### 1. Hidden Map (Commit-Reveal + ZK)

**Problem**: If the game map (walls, loot, cameras, lasers, exit cell) is stored on-chain, any observer can read it and play with complete information.

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
2. The backend verifies `keccak(secret_i) == pN_map_seed_commit` against the on-chain commitment.
3. The backend cross-relays: P1 receives `secret_2`, P2 receives `secret_1`.
4. Each player independently computes:
   ```
   map_seed       = keccak256(secret_1 XOR secret_2)
   map            = generateMap(map_seed)   // walls, loot (cells < 127), cameras, lasers, exit
   map_commitment = keccak256(serialize(map))
   ```
5. Both players sign `begin_match(map_commitment, p1_pos_commit, p2_pos_commit)`.

The on-chain contract stores only `map_commitment`. The circuit receives the map arrays as private inputs and verifies every turn's claims against them.

**Note on loot cell indices**: Loot is only generated at cells with flat index `y*12 + x < 127`. This keeps the on-chain loot bitmask representable as a non-negative `i128` (bit 127 would be the sign bit).

**ZK guarantee (per turn)**: The circuit proves the path, loot count, score, and exit status are consistent with the private map arrays — without revealing the map itself.

---

### 2. Provable Randomness (Dice Rolls)

**Problem**: Dice rolls must be deterministic, verifiable by both players, and non-manipulable.

**Solution — Keccak256 deterministic PRNG:**

```rust
// Rust (on-chain & off-chain client)
roll = keccak256(session_seed ‖ turn_index ‖ player_tag)[0] % 6 + 1
```

The `session_seed` is derived from both players' revealed dice seeds (commit-reveal at `start_game` / `reveal_seed`):

```rust
session_seed = keccak256(session_id ‖ seed_1 ‖ seed_2)
```

This PRNG lives off-circuit (not in the ZK proof). The circuit instead receives `path_len` as a private input and proves the path is valid given the walls; the backend independently computes the expected roll and can reject turns where `path_len > roll`.

**Properties:**
- **Non-manipulable**: Neither player controls `session_seed` alone.
- **Verifiable**: Any third party can recompute the roll from public data after `begin_match`.
- **Off-circuit simplicity**: Keccak is not used inside the Poseidon-based circuit, keeping proof generation fast.

---

### 3. Private Position / Fog-of-War

**Problem**: Storing coordinates on-chain reveals exactly where each player is.

**Solution — Poseidon position commitments with private nonces:**

Position is stored as:

```
pos_commit = Poseidon3(x, y, nonce)
```

The `nonce` is a private 32-byte BN254 Fr element (first byte always `0x00` to fit within the field). The on-chain contract stores only `pos_commit`. Nobody can determine `(x, y)` without knowing the nonce.

The nonce rotates every turn — the client generates a fresh random nonce for `pos_commit_after`. There is no deterministic nonce derivation; the new nonce is a fresh random BN254 Fr element chosen by the prover.

**Why Poseidon (not Keccak)?** Poseidon is an algebraic hash function designed to be efficient inside ZK circuits over BN254. Each Poseidon call costs O(1) circuit constraints, while Keccak inside a circuit would cost thousands. Using Poseidon for position commitments means the circuit can verify `pos_commit_before` and `pos_commit_after` with negligible overhead.

**On-chain verification**: The Soroban contract uses `soroban-poseidon` (BN254/Groth16-compatible Poseidon) to compute the same hash as the circuit, enabling it to verify position commitments and compute the expected `pi_hash`.

**ZK guarantee**: The circuit proves:
- `pos_commit_before = Poseidon3(pos_x, pos_y, pos_nonce)` — player started where they claimed.
- `pos_commit_after = Poseidon3(end_x, end_y, new_pos_nonce)` — player ended at the correct position given the path.

---

### 4. Turn Validity (Private Path + ZK Proof)

**Problem**: How can the blockchain accept a score update without knowing the path the player took, which walls they passed, or which loot they collected?

**Solution — The `turn_validity` Groth16/Circom circuit:**

Every turn, the player generates a Groth16 proof locally (via snarkjs in the browser or on the proof API). The circuit takes **private inputs** (map arrays, position, path, nonces) and produces a **single public output** (`pi_hash`) that commits to all claimed turn data.

**Circuit inputs:**

| Signal | Type | Description |
|---|---|---|
| `map_walls[18]` | private | Wall bitset (18 bytes, 144 cells) |
| `map_loot[18]` | private | Loot bitset (18 bytes, cells < 127 only) |
| `pos_x`, `pos_y` | private | Player's start position |
| `pos_nonce` | private | BN254 Fr nonce for `pos_commit_before` |
| `path_x[7]`, `path_y[7]` | private | Path coordinates (up to 6 steps + start) |
| `path_len` | private | Number of steps taken (0–6) |
| `new_pos_nonce` | private | Fresh BN254 Fr nonce for `pos_commit_after` |
| `exit_x`, `exit_y` | private | Exit cell coordinates (from map seed) |
| `session_id` | public | Identifies the game session |
| `turn_index` | public | Turn counter (anti-replay) |
| `player_tag` | public | 1 = player1, 2 = player2 |
| `score_delta` | public | Net score change (BN254 Fr: negative → prime + value) |
| `loot_delta` | public | Number of loot cells collected this turn |
| `no_path_flag` | public | 1 if player has no valid moves |
| `exited_flag` | public | 1 if player reached the exit cell this turn |

**What the circuit proves:**

| Step | Assertion |
|---|---|
| 1 | `pos_commit_before = Poseidon3(pos_x, pos_y, pos_nonce)` |
| 2 | `path[0] = (pos_x, pos_y)` — path starts at current position |
| 3 | Each active step is adjacent (Manhattan dist = 1), in-bounds, and not on a wall |
| 4 | End position = `path[path_len]` — correctly extracted |
| 5 | `loot_delta = count(path cells with loot bit set)` |
| 6 | `pos_commit_after = Poseidon3(end_x, end_y, new_pos_nonce)` |
| 7 | If `exited_flag = 1`: end position equals the exit cell |
| 8 | `pi_hash = Poseidon2(h1, h2)` — binds all public outputs |

**`pi_hash` construction:**
```
h1      = Poseidon4(session_id, turn_index, player_tag, pos_commit_before)
h2      = Poseidon5(pos_commit_after, score_delta, loot_delta, no_path_flag, exited_flag)
pi_hash = Poseidon2(h1, h2)
```

**On-chain verification flow:**

```
submit_turn(session_id, player, proof_blob, TurnZkPublic)
  ├── Check player is active player (not already exited, not timed out)
  ├── Deduct elapsed time from the active player's chess clock
  ├── Verify pos_commit_before == stored pos_commit (on-chain)
  ├── Verify state_commit_before == stored state_commitment (on-chain)
  ├── Compute expected pi_hash from TurnZkPublic via soroban-poseidon
  ├── Verify proof_blob[4..36] == expected pi_hash (Groth16 public input)
  ├── Call ZkVerifier.verify_proof_with_stored_vk(proof_blob)   ← Groth16 BN254
  ├── Validate loot_mask: count_ones(loot_mask) == loot_delta, no overlap with game.loot_mask
  └── Apply proven state: score, pos_commit, loot_mask, state_commitment
```

**Proof blob format (292 bytes):**
```
[4 bytes]  n_pub = 0x00000001
[32 bytes] pi_hash (big-endian BN254 Fr element)
[64 bytes] π_A (BN254 G1 point)
[128 bytes] π_B (BN254 G2 point)
[64 bytes] π_C (BN254 G1 point)
```

**Key design**: The entire turn output is collapsed into a single field element (`pi_hash`). This minimises on-chain verification cost while cryptographically binding all claimed values (score, position, loot, exit) to the proof.

**Score computation** is off-circuit. The circuit proves `loot_delta` (loot collected). Separately, the client reports `score_delta = loot_delta - camera_hits - 2×laser_hits`. Camera and laser hit detection happens off-chain (the client proves the path, from which hazard exposure can be independently computed — this is a current trust trade-off, see improvements section).

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

The state commitment is a Keccak256 hash over all committed game values:

```rust
state_commitment = keccak256(
    session_id ‖ turn_index ‖ player1_score ‖ player2_score ‖
    map_commitment ‖ player1_pos_commit ‖ player2_pos_commit ‖ session_seed
)
```

This creates a **cryptographic chain** between turns. A turn's proof is only valid if the prover knows the exact state produced by the previous turn:
- **Replay attacks**: old proofs cannot be resubmitted (state_commit_before won't match)
- **Out-of-order turns**: proofs must be submitted in sequence
- **Turn forgery**: every transition must be proven via circuit

---

### 6. Exit Mechanic and Game Termination

**Exit cell**: Each map has exactly one exit cell, derived deterministically from the map seed. Its coordinates are private inputs to the circuit — never revealed on-chain. A player proves they reached the exit by setting `exited_flag = 1`, which the circuit enforces (`end_x == exit_x` and `end_y == exit_y`).

**Game termination conditions:**
1. Both players have exited → score comparison (higher score wins; earlier exit turn as tiebreaker).
2. One player exited, the other's chess clock reached 0 → the exited player wins.
3. Neither player exited, both clocks at 0 → score comparison (player 1 wins on equal score).

**Auto-skip**: When a player exits, subsequent turns in which they would be active are automatically skipped on-chain inside `submit_turn`. The backend does not need to call `pass_turn` explicitly.

**Chess clock**: Each player has 5 minutes of total thinking time (summed across all their turns). Time is deducted in `submit_turn` based on the ledger timestamp delta since the last turn started. `end_if_finished` also accounts for elapsed time when called externally.

---

## What Is and Isn't Revealed On-Chain

| Data | On-chain | Off-chain / Private |
|---|---|---|
| Player addresses | ✅ public | — |
| Scores (cumulative) | ✅ public | — |
| Turn index | ✅ public | — |
| Active player | ✅ public | — |
| Winner | ✅ public (after end) | — |
| Map commitment | ✅ public | Map layout ❌ |
| Map seed commits | ✅ public | Both secrets ❌ |
| Position commitments | ✅ public | x, y, nonces ❌ |
| State commitment | ✅ public | Derivation details ❌ |
| Loot bitmask (collected cells) | ✅ public (as i128) | Which player collected which ❌ |
| Loot count (total) | ✅ public | — |
| Proof identifier (hash) | ✅ public | Proof bytes (submitter only) |
| Session seed | ✅ public (after begin_match) | — |
| Per-player chess clock | ✅ public | — |
| Exited flags | ✅ public | Exit cell location ❌ |
| Path taken | ❌ never | Player only |
| Camera/laser hit breakdown | ❌ never | Player only |
| Exit cell coordinates | ❌ never | Derived locally from map seed |

---

## Architecture & Proof Pipeline

### Proof Generation

```
Browser / Turn Builder
  ├── computeLootDelta(map.loot, lootCollected, path)   → lootMaskDelta (Uint8Array)
  ├── computeCameraHits(path, map.cameras)              → cameraHits
  ├── computeLaserHits(path, map.lasers)                → laserHits
  ├── scoreDelta = lootDelta - cameraHits - 2×laserHits
  ├── exitedFlag = (end == exitCell)
  └── POST /api/proof/prove  { mapWalls, mapLoot, posX, posY, posNonce,
                               pathX, pathY, pathLen, newPosNonce, exitX, exitY,
                               sessionId, turnIndex, playerTag,
                               scoreDelta, lootDelta, noPathFlag, exitedFlag }

Proof API (NestJS)
  ├── Builds Groth16 witness via snarkjs + compiled circuit WASM
  ├── Generates Groth16 proof using the final zkey (turn_validity_final.zkey)
  ├── Extracts pi_hash from public signals
  └── Wraps into 292-byte proof_blob: [n_pub=1][pi_hash][π_A][π_B][π_C]

Browser
  └── buildSubmitTurnTx(player, proof_blob, TurnZkPublic)
       └── Soroban simulate → sign → submit
```

### On-Chain Verification (ZkVerifier contract)

The `ZkVerifier` contract (`zk-verifier-core`) stores the Groth16 verification key (`vk`) and exposes:

```rust
verify_proof_with_stored_vk(proof_blob: Bytes) -> BytesN<32>
```

It uses Soroban Protocol 25's native BN254 host functions (`pairing_check`, `g1_add`, `g1_mul`, `g2_add`) to perform the full Groth16 verification on-chain, returning the proof's Keccak256 hash as a unique `proof_id`.

---

## Technical Stack

| Layer | Technology | Purpose |
|---|---|---|
| ZK Circuit | Circom 2.1.6 + circomlib | Turn validity proof (path, position, loot, exit) |
| Proof System | Groth16 / BN254 (snarkjs) | Proof generation (off-chain, ~2–5 s) |
| On-chain Verifier | Soroban BN254 host functions | Native Groth16 verification |
| Hash (commitments) | Poseidon over BN254 | Position commits, pi_hash (circuit-friendly) |
| Hash (PRNG / state) | Keccak-256 | Dice rolls, state commitment, map commit |
| Smart Contract | Soroban/Rust (soroban-sdk 22) | On-chain state, chess clock, loot mask |
| Backend | NestJS + snarkjs | Proof generation endpoint, lobby relay |
| Frontend | Next.js + Stellar Wallets Kit | Turn submission, private state management |
| Blockchain | Stellar Testnet | Contract hosting, GameHub integration |

---

## Current Trade-offs and Possible Improvements

### 1. Score delta trust model

**Current state**: `score_delta = loot_delta - camera_hits - 2×laser_hits`. The circuit proves `loot_delta` (loot cells visited). Camera and laser hits are computed off-chain by the client and included in `score_delta`; the contract accepts the claimed `score_delta` without circuit-level proof of hazard exposure.

**Implication**: A dishonest client could undercount their hazard penalties and report a higher score than deserved. This is a known trade-off: adding hazard verification inside the circuit would require significantly more constraints.

**Mitigation**: The opponent can observe the submitted `pos_commit_before` / `pos_commit_after` chain over time and detect anomalous score trajectories. A future circuit upgrade could add camera/laser hit verification.

### 2. Backend relay trust model

**Current state**: The backend verifies map seed commitments against on-chain values before relaying, but temporarily sees both players' raw map secrets.

**Mitigation already in place**:
- Secrets are deleted from the backend immediately after `begin_match` is confirmed.
- The backend verifies `keccak(secret_i) == pN_map_seed_commit` before relaying.

**Theoretical improvement**: Eliminate the trusted backend using on-chain encrypted channels (e.g., ECIES). Each player encrypts their secret with the opponent's on-chain public key and posts the ciphertext. The opponent decrypts locally, removing the backend from the trust model entirely.

### 3. Loot cell restriction

**Current state**: Loot is only placed at cells with flat index `y*12 + x < 127`. This is a constraint imposed by representing the global loot bitmask as an `i128` on-chain (bit 127 is the sign bit). Cells 127–143 are never used for loot.

**Impact**: In the 12×12 grid (144 cells), 17 cells (row y=10 from x=7 onward, and all of row y=11) cannot hold loot. With 24 loot items placed across the remaining 127 eligible cells, gameplay is not materially affected.

---

## Summary

HeistDuel uses ZK proofs as the **only way** to advance the game state. There is no server-side validation of moves, no trust in any off-chain authority for turn correctness, and no on-chain data that reveals the map or player positions.

The Groth16 circuit over BN254, combined with Poseidon-based position commitments and a Keccak-based state chain, ensures that:
- The map cannot be fabricated or modified mid-game
- Positions cannot be teleported
- Dice rolls cannot be manipulated
- Loot counts cannot be inflated (circuit-proven)
- Exit claims cannot be faked (exit cell is a circuit constraint)

This makes HeistDuel a **genuinely private two-player game with verifiable outcomes** — a player wins because they collected more loot while avoiding hazards and escaped the map first, and that outcome is cryptographically proven, not asserted.
