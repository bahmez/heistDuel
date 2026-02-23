# Heist — Game Contract

Soroban contract that implements the HeistDuel game: session lifecycle, commit-reveal for map and dice seeds, turn submission with Groth16 proof verification, score and loot tracking, chess clock, and exit handling.

## Dependencies

- `soroban-sdk` 25.1.1
- `soroban-poseidon` 25.0.0 (for `pi_hash` and position commitment verification)

## Game lifecycle

1. **start_game** — Players (or backend) call with map seed commitments and optional dice seed commitments. Creates a session in `WaitingReveal`.
2. **reveal_seed** — Each player reveals their seeds; contract checks `keccak(reveal) == commit`. After both revealed, `session_seed` is derived.
3. **begin_match** — Backend calls with `session_id` after relaying map secrets off-chain. Contract combines seeds, derives `map_commitment`, and moves to `Active`. Players' initial position commitments are set.
4. **submit_turn** — Active player submits a Groth16 proof blob and `TurnZkPublic`. Contract checks chess clock, position/state commitments, computes expected `pi_hash` via Poseidon, calls `zk-verifier.verify_proof_with_stored_vk`, then applies score, loot mask, and position updates. If the next player has already exited, the turn is auto-advanced.
5. **pass_turn** — Optional; used to skip a turn (e.g. no valid move). Auto-skip of exited players is done inside `submit_turn`.
6. **end_if_finished** — Anyone can call; ends the game when both players exited or clocks are exhausted, and notifies the GameHub.

## Main types

- **Game** — Full game state (players, scores, status, commitments, chess clock, loot mask as `i128`, exit flags, etc.).
- **GameView** — Public view returned by `get_game` (same data, no sensitive fields).
- **TurnZkPublic** — Public inputs/outputs for a turn: `session_id`, `turn_index`, `player`, `score_delta`, `loot_delta`, `loot_mask` (i128), `pos_commit_before`/`pos_commit_after`, `state_commit_before`/`state_commit_after`, `no_path_flag`, `exited_flag`.

Loot is tracked as a single `i128` bitmask (cells 0–126); the circuit and engine restrict loot to those indices.

## Public API summary

- **Lifecycle**: `__constructor(admin, game_hub, verifier)`, `start_game(...)`, `reveal_seed(session_id, player, seed_reveal)`, `begin_match(session_id)`
- **Turns**: `submit_turn(session_id, player, proof_blob, public_turn)`, `pass_turn(session_id)`
- **End**: `end_if_finished(session_id)`
- **Views**: `get_game(session_id)`, `get_state_commitment(session_id)`, `get_expected_roll(session_id, player)`
- **Admin**: `set_admin`, `set_hub`, `set_verifier`, `upgrade(new_wasm_hash)`

## ZK integration

- The contract expects a **Groth16** proof blob (292 bytes) and a `TurnZkPublic` payload.
- It computes the expected **pi_hash** using `soroban-poseidon` (same formula as the Circom circuit: Poseidon2 of two Poseidon hashes over the public turn data).
- It calls the **zk-verifier** contract's `verify_proof_with_stored_vk(proof_blob)`; on success, it checks that the public input in the blob matches the computed `pi_hash`, then applies the turn.

## Errors

See `Error` enum in `lib.rs`: e.g. `GameNotFound`, `NotActivePlayer`, `InvalidTurnData`, `StateCommitMismatch`, `TimerExpired`, `ProofRequired`, `PlayerAlreadyExited`, etc.

## Tests

```bash
cd apps/contracts/heist
cargo test
```

Tests cover session flow, turn validation, timer expiration, and tie-breaker behaviour.
