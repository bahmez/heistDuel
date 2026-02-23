#![no_std]

mod engine;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short,
    vec, Address, Bytes, BytesN, Env, IntoVal,
};

use engine::{
    commit_hash, compute_state_commitment, compute_turn_pi_hash,
    derive_session_seed, roll_value, PLAYER_TIME_SECONDS,
};

const GAME_TTL_LEDGERS: u32 = 518_400;

#[contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(env: Env, session_id: u32, player1_won: bool);
}

/// Matches the actual ultrahonk_soroban_contract interface.
/// The single public input (pi_hash) is embedded inside proof_blob;
/// the contract verifies it matches TurnZkPublic before calling this.
#[contractclient(name = "ZkVerifierClient")]
pub trait ZkVerifier {
    fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> BytesN<32>;
}

#[contracterror]
#[derive(Copy, Clone)]
#[repr(u32)]
pub enum Error {
    GameNotFound = 1,
    NotPlayer = 2,
    GameAlreadyStarted = 3,
    GameAlreadyEnded = 4,
    InvalidSeedReveal = 5,
    SeedAlreadyRevealed = 6,
    SeedsNotReady = 7,
    NotActivePlayer = 8,
    InvalidTurnData = 9,
    InvalidScoreDelta = 12,
    StateCommitMismatch = 15,
    TimerExpired = 16,
    InvalidStatus = 17,
    ProofRequired = 18,
    InvalidPublicInput = 19,
    PlayerAlreadyExited = 20,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum GameStatus {
    WaitingReveal,
    Active,
    Ended,
}

#[contracttype]
#[derive(Clone)]
pub struct TurnZkPublic {
    pub session_id: u32,
    pub turn_index: u32,
    pub player: Address,
    pub score_delta: i128,
    pub loot_delta: u32,
    // Bitmask of loot cells collected this turn (cells 0-126, flat index y*12+x).
    // Bit N set means cell N was collected. count_ones() must equal loot_delta.
    // Must not overlap with game.loot_mask (prevents double-collecting).
    // Stored as i128; cell indices limited to 0-126 so value is always >= 0.
    pub loot_mask: i128,
    pub pos_commit_before: BytesN<32>,
    pub pos_commit_after: BytesN<32>,
    pub state_commit_before: BytesN<32>,
    pub state_commit_after: BytesN<32>,
    pub no_path_flag: bool,
    pub exited_flag: bool,
}

#[contracttype]
#[derive(Clone)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub status: GameStatus,
    pub p1_seed_commit: BytesN<32>,
    pub p2_seed_commit: BytesN<32>,
    // Zero hash = not yet revealed.
    pub p1_seed_reveal: BytesN<32>,
    pub p2_seed_reveal: BytesN<32>,
    // Zero hash = seeds not yet combined.
    pub session_seed: BytesN<32>,
    pub p1_map_seed_commit: BytesN<32>,
    pub p2_map_seed_commit: BytesN<32>,
    pub map_commitment: BytesN<32>,
    pub player1_pos_commit: BytesN<32>,
    pub player2_pos_commit: BytesN<32>,
    pub player1_score: i128,
    pub player2_score: i128,
    pub loot_total_collected: u32,
    // Global loot collected bitmask (cells 0-126, always >= 0).
    pub loot_mask: i128,
    pub state_commitment: BytesN<32>,
    // 0 = not yet started.
    pub started_at_ts: u64,
    pub turn_index: u32,
    pub active_player: Address,
    pub winner: Option<Address>,
    // Zero hash = no proof yet.
    pub last_proof_id: BytesN<32>,
    pub p1_time_remaining: u64,
    pub p2_time_remaining: u64,
    pub last_turn_start_ts: u64,
    pub player1_exited: bool,
    pub player2_exited: bool,
    // u64::MAX = not yet exited; otherwise the turn_index when this player exited.
    pub p1_exit_turn: u64,
    pub p2_exit_turn: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct GameView {
    pub player1: Address,
    pub player2: Address,
    pub status: GameStatus,
    // 0 = not yet started.
    pub started_at_ts: u64,
    pub turn_index: u32,
    pub active_player: Address,
    pub player1_score: i128,
    pub player2_score: i128,
    pub loot_total_collected: u32,
    pub loot_mask: i128,
    pub map_commitment: BytesN<32>,
    pub player1_pos_commit: BytesN<32>,
    pub player2_pos_commit: BytesN<32>,
    pub p1_map_seed_commit: BytesN<32>,
    pub p2_map_seed_commit: BytesN<32>,
    pub state_commitment: BytesN<32>,
    pub winner: Option<Address>,
    // Zero hash = no proof yet.
    pub last_proof_id: BytesN<32>,
    pub p1_time_remaining: u64,
    pub p2_time_remaining: u64,
    pub last_turn_start_ts: u64,
    pub player1_exited: bool,
    pub player2_exited: bool,
}

// ── Loot mask helpers (i128 bitmask, cells 0-126) ─────────────────────────────

#[inline(always)]
fn count_loot_bits(mask: i128) -> u32 {
    mask.count_ones()
}

#[inline(always)]
fn loot_bits_overlap(a: i128, b: i128) -> bool {
    (a & b) != 0
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    Admin,
    GameHubAddress,
    VerifierAddress,
}

#[contract]
pub struct HeistContract;

#[contractimpl]
impl HeistContract {
    pub fn __constructor(env: Env, admin: Address, game_hub: Address, verifier: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &game_hub);
        env.storage()
            .instance()
            .set(&DataKey::VerifierAddress, &verifier);
    }

    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
        p1_seed_commit: BytesN<32>,
        p2_seed_commit: BytesN<32>,
        p1_map_seed_commit: BytesN<32>,
        p2_map_seed_commit: BytesN<32>,
    ) -> Result<(), Error> {
        if player1 == player2 {
            panic!("Cannot play against yourself");
        }
        if Self::load_game(&env, session_id).is_some() {
            return Err(Error::GameAlreadyStarted);
        }

        player1.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player1_points.into_val(&env),
            p1_seed_commit.clone().into_val(&env),
            p1_map_seed_commit.clone().into_val(&env),
        ]);
        player2.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player2_points.into_val(&env),
            p2_seed_commit.clone().into_val(&env),
            p2_map_seed_commit.clone().into_val(&env),
        ]);

        // Notify hub of the new session. Non-fatal — game proceeds even if hub is
        // unavailable (e.g. during isolated testnet deployments).
        if let Some(hub_addr) = env.storage().instance().get::<_, Address>(&DataKey::GameHubAddress) {
            let hub = GameHubClient::new(&env, &hub_addr);
            let _ = hub.try_start_game(
                &env.current_contract_address(),
                &session_id,
                &player1,
                &player2,
                &player1_points,
                &player2_points,
            );
        }

        let zero32 = BytesN::from_array(&env, &[0u8; 32]);
        let game = Game {
            player1: player1.clone(),
            player2: player2.clone(),
            player1_points,
            player2_points,
            status: GameStatus::WaitingReveal,
            p1_seed_commit,
            p2_seed_commit,
            p1_seed_reveal: zero32.clone(),
            p2_seed_reveal: zero32.clone(),
            session_seed: zero32.clone(),
            p1_map_seed_commit,
            p2_map_seed_commit,
            map_commitment: zero32.clone(),
            player1_pos_commit: zero32.clone(),
            player2_pos_commit: zero32.clone(),
            player1_score: 0,
            player2_score: 0,
            loot_total_collected: 0,
            loot_mask: 0i128,
            state_commitment: zero32.clone(),
            started_at_ts: 0,
            turn_index: 0,
            active_player: player1.clone(),
            winner: None,
            last_proof_id: zero32,
            p1_time_remaining: PLAYER_TIME_SECONDS,
            p2_time_remaining: PLAYER_TIME_SECONDS,
            last_turn_start_ts: 0,
            player1_exited: false,
            player2_exited: false,
            p1_exit_turn: u64::MAX,
            p2_exit_turn: u64::MAX,
        };

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    pub fn reveal_seed(
        env: Env,
        session_id: u32,
        player: Address,
        seed_secret: BytesN<32>,
    ) -> Result<(), Error> {
        player.require_auth();

        let mut game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::WaitingReveal {
            return Err(Error::InvalidStatus);
        }

        let zero32 = BytesN::from_array(&env, &[0u8; 32]);
        let reveal_hash = commit_hash(&env, &seed_secret);

        if player == game.player1 {
            if game.p1_seed_reveal != zero32 {
                return Err(Error::SeedAlreadyRevealed);
            }
            if reveal_hash != game.p1_seed_commit {
                return Err(Error::InvalidSeedReveal);
            }
            game.p1_seed_reveal = seed_secret;
        } else if player == game.player2 {
            if game.p2_seed_reveal != zero32 {
                return Err(Error::SeedAlreadyRevealed);
            }
            if reveal_hash != game.p2_seed_commit {
                return Err(Error::InvalidSeedReveal);
            }
            game.p2_seed_reveal = seed_secret;
        } else {
            return Err(Error::NotPlayer);
        }

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    pub fn begin_match(
        env: Env,
        session_id: u32,
        map_commitment: BytesN<32>,
        p1_pos_commit: BytesN<32>,
        p2_pos_commit: BytesN<32>,
    ) -> Result<(), Error> {
        let mut game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::WaitingReveal {
            return Err(Error::InvalidStatus);
        }
        game.player1.require_auth();
        game.player2.require_auth();

        let zero32 = BytesN::from_array(&env, &[0u8; 32]);
        if game.p1_seed_reveal == zero32 || game.p2_seed_reveal == zero32 {
            return Err(Error::SeedsNotReady);
        }
        let p1 = game.p1_seed_reveal.clone();
        let p2 = game.p2_seed_reveal.clone();

        let session_seed = derive_session_seed(&env, session_id, &p1, &p2);
        let now = env.ledger().timestamp();

        // Compute initial state commitment without deadline (chess clocks replace global timer).
        let state_commitment = compute_state_commitment(
            &env,
            session_id,
            0, // turn_index starts at 0
            0, // player1_score starts at 0
            0, // player2_score starts at 0
            &map_commitment,
            &p1_pos_commit,
            &p2_pos_commit,
            &session_seed,
        );

        game.session_seed = session_seed;
        game.map_commitment = map_commitment;
        game.player1_pos_commit = p1_pos_commit;
        game.player2_pos_commit = p2_pos_commit;
        game.loot_total_collected = 0;
        game.state_commitment = state_commitment;
        game.started_at_ts = now;
        game.status = GameStatus::Active;
        game.active_player = game.player1.clone();
        game.turn_index = 0;
        // Initialize per-player chess clocks.
        game.p1_time_remaining = PLAYER_TIME_SECONDS;
        game.p2_time_remaining = PLAYER_TIME_SECONDS;
        game.last_turn_start_ts = now;

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    pub fn submit_turn(
        env: Env,
        session_id: u32,
        player: Address,
        proof_blob: Bytes,
        public_turn: TurnZkPublic,
    ) -> Result<(), Error> {
        player.require_auth();

        let mut game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::Active {
            return Err(Error::GameAlreadyEnded);
        }
        if player != game.active_player {
            return Err(Error::NotActivePlayer);
        }
        if public_turn.player != player || public_turn.session_id != session_id {
            return Err(Error::InvalidTurnData);
        }
        if public_turn.turn_index != game.turn_index {
            return Err(Error::InvalidTurnData);
        }

        let is_player1 = player == game.player1;

        // Block an already-exited player from submitting any further turns.
        // The backend should call pass_turn() to advance past them instead.
        if is_player1 && game.player1_exited {
            return Err(Error::PlayerAlreadyExited);
        }
        if !is_player1 && game.player2_exited {
            return Err(Error::PlayerAlreadyExited);
        }

        // Deduct elapsed time from the active player's chess clock.
        let now = env.ledger().timestamp();
        let elapsed = now.saturating_sub(game.last_turn_start_ts);
        if is_player1 {
            if elapsed >= game.p1_time_remaining {
                game.p1_time_remaining = 0;
                game.active_player = game.player2.clone();
                Self::save_game(&env, session_id, &game);
                Self::end_if_finished(env.clone(), session_id)?;
                return Err(Error::TimerExpired);
            }
            game.p1_time_remaining -= elapsed;
        } else {
            if elapsed >= game.p2_time_remaining {
                game.p2_time_remaining = 0;
                game.active_player = game.player1.clone();
                Self::save_game(&env, session_id, &game);
                Self::end_if_finished(env.clone(), session_id)?;
                return Err(Error::TimerExpired);
            }
            game.p2_time_remaining -= elapsed;
        }

        // Groth16 proof blob: [4 n_pub=1][32 pi_hash][64 pi_a][128 pi_b][64 pi_c] = 292 bytes
        if proof_blob.len() < 292 {
            return Err(Error::ProofRequired);
        }

        // Verify pos_commit_before matches stored commitment for the active player.
        let expected_pos_commit_before = if is_player1 {
            game.player1_pos_commit.clone()
        } else {
            game.player2_pos_commit.clone()
        };
        if public_turn.pos_commit_before != expected_pos_commit_before {
            return Err(Error::InvalidTurnData);
        }

        // Verify state_commit_before matches current on-chain state commitment.
        if public_turn.state_commit_before != game.state_commitment {
            return Err(Error::StateCommitMismatch);
        }

        let player_tag: u32 = if is_player1 { 1 } else { 2 };

        // Compute the expected pi_hash from public turn data.
        let expected_pi = compute_turn_pi_hash(
            &env,
            session_id,
            game.turn_index,
            player_tag,
            &public_turn.pos_commit_before,
            &public_turn.pos_commit_after,
            public_turn.score_delta,
            public_turn.loot_delta,
            public_turn.no_path_flag,
            public_turn.exited_flag,
        );

        // Verify proof_blob[0..4] = 0x00000001 (count = 1 public input).
        let count = ((proof_blob.get(0).unwrap_or(0) as u32) << 24)
            | ((proof_blob.get(1).unwrap_or(0) as u32) << 16)
            | ((proof_blob.get(2).unwrap_or(0) as u32) << 8)
            | (proof_blob.get(3).unwrap_or(0) as u32);
        if count != 1 {
            return Err(Error::InvalidPublicInput);
        }

        // Verify proof_blob[4..36] matches the computed pi_hash.
        let mut embedded_pi = [0u8; 32];
        let mut k = 0u32;
        while k < 32 {
            embedded_pi[k as usize] = proof_blob.get(4 + k).unwrap_or(0);
            k += 1;
        }
        let mut expected_pi_arr = [0u8; 32];
        let mut k = 0u32;
        while k < 32 {
            expected_pi_arr[k as usize] = expected_pi.get(k).unwrap_or(0);
            k += 1;
        }
        if embedded_pi != expected_pi_arr {
            return Err(Error::InvalidPublicInput);
        }

        // Call the ZK verifier.
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierAddress)
            .expect("verifier missing");
        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        let proof_id = verifier.verify_proof_with_stored_vk(&proof_blob);

        // Apply proven state changes.
        if is_player1 {
            game.player1_score = game
                .player1_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            game.player1_pos_commit = public_turn.pos_commit_after.clone();
            if public_turn.exited_flag {
                game.player1_exited = true;
                game.p1_exit_turn = game.turn_index as u64;
            }
        } else {
            game.player2_score = game
                .player2_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            game.player2_pos_commit = public_turn.pos_commit_after.clone();
            if public_turn.exited_flag {
                game.player2_exited = true;
                game.p2_exit_turn = game.turn_index as u64;
            }
        }

        // Validate loot mask: popcount must match the circuit-proven count,
        // and no bit may overlap with already globally-collected loot cells.
        if count_loot_bits(public_turn.loot_mask) != public_turn.loot_delta {
            return Err(Error::InvalidTurnData);
        }
        if loot_bits_overlap(public_turn.loot_mask, game.loot_mask) {
            return Err(Error::InvalidTurnData);
        }
        // Accumulate global loot mask and total count.
        game.loot_mask |= public_turn.loot_mask;
        game.loot_total_collected = game
            .loot_total_collected
            .saturating_add(public_turn.loot_delta);
        game.turn_index += 1;
        game.state_commitment = public_turn.state_commit_after.clone();
        game.last_proof_id = proof_id.clone();
        game.last_turn_start_ts = now;

        // Advance to next active player. If they have already exited,
        // skip them immediately so the backend never needs to call pass_turn().
        game.active_player = if is_player1 {
            game.player2.clone()
        } else {
            game.player1.clone()
        };
        {
            let next_is_p1 = game.active_player == game.player1;
            let next_exited = if next_is_p1 { game.player1_exited } else { game.player2_exited };
            if next_exited {
                game.active_player = if next_is_p1 {
                    game.player2.clone()
                } else {
                    game.player1.clone()
                };
            }
        }

        Self::save_game(&env, session_id, &game);
        env.events()
            .publish((symbol_short!("turn"), session_id), proof_id);

        Self::end_if_finished(env.clone(), session_id)?;
        Ok(())
    }

    pub fn pass_turn(env: Env, session_id: u32) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing");
        admin.require_auth();

        let mut game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::Active {
            return Err(Error::GameAlreadyEnded);
        }

        let active_is_p1 = game.active_player == game.player1;
        let active_has_exited = if active_is_p1 {
            game.player1_exited
        } else {
            game.player2_exited
        };

        if !active_has_exited {
            // Nothing to pass — active player has not exited.
            return Err(Error::NotActivePlayer);
        }

        // Advance to the non-exited player.
        game.active_player = if active_is_p1 {
            game.player2.clone()
        } else {
            game.player1.clone()
        };

        // Reset the clock baseline so the new active player's clock starts now.
        game.last_turn_start_ts = env.ledger().timestamp();

        Self::save_game(&env, session_id, &game);
        Self::end_if_finished(env.clone(), session_id)?;
        Ok(())
    }

    pub fn end_if_finished(env: Env, session_id: u32) -> Result<(), Error> {
        let mut game = Self::require_game(&env, session_id)?;

        if game.status == GameStatus::Ended {
            return Ok(());
        }

        // Account for time elapsed since the current turn started.
        if game.status == GameStatus::Active {
            let now = env.ledger().timestamp();
            let elapsed = now.saturating_sub(game.last_turn_start_ts);
            if game.active_player == game.player1 {
                if elapsed >= game.p1_time_remaining {
                    game.p1_time_remaining = 0;
                }
            } else if elapsed >= game.p2_time_remaining {
                game.p2_time_remaining = 0;
            }
        }

        let p1_clock_out = game.p1_time_remaining == 0;
        let p2_clock_out = game.p2_time_remaining == 0;
        let both_exited = game.player1_exited && game.player2_exited;
        let game_over = both_exited || p1_clock_out || p2_clock_out;

        if !game_over {
            return Ok(());
        }

        // Determine winner.
        let player1_won = if both_exited {
            // Both exited: higher score wins; tie → earlier exit_turn wins.
            if game.player1_score != game.player2_score {
                game.player1_score > game.player2_score
            } else {
                // Earlier exit wins (lower turn number; u64::MAX = not exited).
                game.p1_exit_turn <= game.p2_exit_turn
            }
        } else if game.player1_exited && p2_clock_out {
            // Only player1 exited and player2 timed out → player1 wins.
            true
        } else if game.player2_exited && p1_clock_out {
            // Only player2 exited and player1 timed out → player2 wins.
            false
        } else {
            // Neither exited (or only one exited without the other timing out) → score tiebreak.
            game.player1_score >= game.player2_score
        };

        let winner = if player1_won {
            game.player1.clone()
        } else {
            game.player2.clone()
        };

        game.status = GameStatus::Ended;
        game.winner = Some(winner);
        Self::save_game(&env, session_id, &game);

        // Notify hub of the result. Non-fatal — the game is already recorded as Ended
        // on-chain; a hub failure must not prevent the turn transaction from succeeding.
        if let Some(hub_addr) = env.storage().instance().get::<_, Address>(&DataKey::GameHubAddress) {
            let hub = GameHubClient::new(&env, &hub_addr);
            let _ = hub.try_end_game(&session_id, &player1_won);
        }

        env.events().publish(
            (symbol_short!("ended"), session_id),
            (game.player1_score, game.player2_score, player1_won),
        );

        Ok(())
    }

    pub fn get_game(env: Env, session_id: u32) -> Result<GameView, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing");
        admin.require_auth();
        let game = Self::require_game(&env, session_id)?;
        Ok(GameView {
            player1: game.player1,
            player2: game.player2,
            status: game.status,
            started_at_ts: game.started_at_ts,
            turn_index: game.turn_index,
            active_player: game.active_player,
            player1_score: game.player1_score,
            player2_score: game.player2_score,
            loot_total_collected: game.loot_total_collected,
            loot_mask: game.loot_mask,
            map_commitment: game.map_commitment,
            player1_pos_commit: game.player1_pos_commit,
            player2_pos_commit: game.player2_pos_commit,
            p1_map_seed_commit: game.p1_map_seed_commit,
            p2_map_seed_commit: game.p2_map_seed_commit,
            state_commitment: game.state_commitment,
            winner: game.winner,
            last_proof_id: game.last_proof_id,
            p1_time_remaining: game.p1_time_remaining,
            p2_time_remaining: game.p2_time_remaining,
            last_turn_start_ts: game.last_turn_start_ts,
            player1_exited: game.player1_exited,
            player2_exited: game.player2_exited,
        })
    }

    pub fn get_state_commitment(env: Env, session_id: u32) -> Result<BytesN<32>, Error> {
        let game = Self::require_game(&env, session_id)?;
        Ok(game.state_commitment.clone())
    }

    pub fn get_expected_roll(env: Env, session_id: u32, player: Address) -> Result<u32, Error> {
        let game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::Active {
            return Err(Error::InvalidStatus);
        }
        let player_tag = if player == game.player1 {
            1
        } else if player == game.player2 {
            2
        } else {
            return Err(Error::NotPlayer);
        };
        Ok(roll_value(&env, game.session_seed, game.turn_index, player_tag))
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing");
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn set_verifier(env: Env, new_verifier: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing");
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::VerifierAddress, &new_verifier);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    fn load_game(env: &Env, session_id: u32) -> Option<Game> {
        env.storage().temporary().get(&DataKey::Game(session_id))
    }

    fn require_game(env: &Env, session_id: u32) -> Result<Game, Error> {
        Self::load_game(env, session_id).ok_or(Error::GameNotFound)
    }

    fn save_game(env: &Env, session_id: u32, game: &Game) {
        let key = DataKey::Game(session_id);
        env.storage().temporary().set(&key, game);
        env.storage()
            .temporary()
            .extend_ttl(&key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);
    }
}

#[cfg(test)]
mod test;
