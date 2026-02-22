#![no_std]

mod engine;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short,
    vec, Address, Bytes, BytesN, Env, IntoVal,
};

use engine::{
    commit_hash, compute_pos_commit, compute_state_commitment, compute_turn_pi_hash,
    derive_session_seed, roll_value, GAME_SECONDS, LOOT_COUNT,
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
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GameStatus {
    WaitingReveal,
    Active,
    Ended,
}

/// Minimal public data committed per turn.
/// All game-logic details (path, position, dice, hazards) are private
/// and proven inside the ZK circuit. Only the outputs are public.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnZkPublic {
    pub session_id: u32,
    pub turn_index: u32,
    pub player: Address,
    /// Net score change this turn (can be negative from hazard penalties).
    pub score_delta: i128,
    /// Number of new loot items collected (always >= 0).
    pub loot_delta: u32,
    /// Position commitment before the move.
    pub pos_commit_before: BytesN<32>,
    /// Position commitment after the move (new position + new nonce).
    pub pos_commit_after: BytesN<32>,
    /// State commitment before the move (must match on-chain state_commitment).
    pub state_commit_before: BytesN<32>,
    /// State commitment after the move (becomes new on-chain state_commitment).
    pub state_commit_after: BytesN<32>,
    /// True when the player has no valid moves (fully surrounded by walls).
    pub no_path_flag: bool,
}

/// On-chain game state after ZK refactor.
/// Raw map data (walls, loot, cameras, lasers, positions, fog) is no longer stored.
/// Only cryptographic commitments are kept on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub status: GameStatus,
    // Dice seed commit-reveal (session_seed becomes public after begin_match)
    pub p1_seed_commit: BytesN<32>,
    pub p2_seed_commit: BytesN<32>,
    pub p1_seed_reveal: Option<BytesN<32>>,
    pub p2_seed_reveal: Option<BytesN<32>>,
    pub session_seed: Option<BytesN<32>>,
    // Map seed commitments — secrets are relayed off-chain via backend.
    // The map_seed = keccak(secret1 XOR secret2) is never posted on-chain.
    pub p1_map_seed_commit: BytesN<32>,
    pub p2_map_seed_commit: BytesN<32>,
    // Map commitment set at begin_match: keccak(generate_map(map_seed)).
    // Proves the correct map was used in ZK proofs without revealing the map.
    pub map_commitment: BytesN<32>,
    // Position commitments: keccak(x ‖ y ‖ player_nonce).
    // Player nonces are private; commitments are updated each turn.
    pub player1_pos_commit: BytesN<32>,
    pub player2_pos_commit: BytesN<32>,
    // Scores are public (accumulated from proven score_delta values).
    pub player1_score: i128,
    pub player2_score: i128,
    // Loot count only (not which cells — proven in circuit).
    pub loot_total_collected: u32,
    // State commitment: keccak of all committed state fields.
    // Chains turns together; must match state_commit_before in each proof.
    pub state_commitment: BytesN<32>,
    pub started_at_ts: Option<u64>,
    pub deadline_ts: Option<u64>,
    pub turn_index: u32,
    pub active_player: Address,
    pub winner: Option<Address>,
    pub last_proof_id: Option<BytesN<32>>,
}

/// Public view of game state — exposes only commitment values, never raw map/positions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GameView {
    pub player1: Address,
    pub player2: Address,
    pub status: GameStatus,
    pub started_at_ts: Option<u64>,
    pub deadline_ts: Option<u64>,
    pub turn_index: u32,
    pub active_player: Address,
    pub player1_score: i128,
    pub player2_score: i128,
    pub loot_total_collected: u32,
    pub map_commitment: BytesN<32>,
    pub player1_pos_commit: BytesN<32>,
    pub player2_pos_commit: BytesN<32>,
    pub p1_map_seed_commit: BytesN<32>,
    pub p2_map_seed_commit: BytesN<32>,
    pub state_commitment: BytesN<32>,
    pub winner: Option<Address>,
    pub last_proof_id: Option<BytesN<32>>,
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
    /// Initializes admin, game hub and verifier addresses.
    pub fn __constructor(env: Env, admin: Address, game_hub: Address, verifier: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &game_hub);
        env.storage()
            .instance()
            .set(&DataKey::VerifierAddress, &verifier);
    }

    /// Creates a new 2-player session.
    ///
    /// Each player commits to two secrets:
    /// - `pN_seed_commit`: for dice PRNG (revealed publicly later via reveal_seed)
    /// - `pN_map_seed_commit`: for map generation (secret stays off-chain; backend relays it)
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

        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("hub missing");
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        let zero32 = BytesN::from_array(&env, &[0u8; 32]);
        let game = Game {
            player1: player1.clone(),
            player2: player2.clone(),
            player1_points,
            player2_points,
            status: GameStatus::WaitingReveal,
            p1_seed_commit,
            p2_seed_commit,
            p1_seed_reveal: None,
            p2_seed_reveal: None,
            session_seed: None,
            p1_map_seed_commit,
            p2_map_seed_commit,
            map_commitment: zero32.clone(),
            player1_pos_commit: zero32.clone(),
            player2_pos_commit: zero32.clone(),
            player1_score: 0,
            player2_score: 0,
            loot_total_collected: 0,
            state_commitment: zero32,
            started_at_ts: None,
            deadline_ts: None,
            turn_index: 0,
            active_player: player1.clone(),
            winner: None,
            last_proof_id: None,
        };

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    /// Reveals a previously committed dice seed from a player.
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

        let reveal_hash = commit_hash(&env, &seed_secret);

        if player == game.player1 {
            if game.p1_seed_reveal.is_some() {
                return Err(Error::SeedAlreadyRevealed);
            }
            if reveal_hash != game.p1_seed_commit {
                return Err(Error::InvalidSeedReveal);
            }
            game.p1_seed_reveal = Some(seed_secret);
        } else if player == game.player2 {
            if game.p2_seed_reveal.is_some() {
                return Err(Error::SeedAlreadyRevealed);
            }
            if reveal_hash != game.p2_seed_commit {
                return Err(Error::InvalidSeedReveal);
            }
            game.p2_seed_reveal = Some(seed_secret);
        } else {
            return Err(Error::NotPlayer);
        }

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    /// Starts the match after both dice seeds are revealed.
    ///
    /// Map is NOT generated on-chain. Players compute the map off-chain from
    /// their private map_seeds (exchanged via backend relay) and submit the
    /// agreed map_commitment and their initial position commitments.
    ///
    /// The backend relay flow (off-chain):
    ///   1. Both players send their map_secret to the backend.
    ///   2. Backend verifies keccak(map_secret_i) == pN_map_seed_commit (on-chain).
    ///   3. Backend cross-relays: P1 gets secret2, P2 gets secret1.
    ///   4. Each player computes: map_seed = keccak(secret1 XOR secret2).
    ///   5. Each player computes: map_data = generate_map(map_seed), map_commitment = keccak(map_data).
    ///   6. Both players sign begin_match() with the same map_commitment.
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

        let p1 = game.p1_seed_reveal.clone().ok_or(Error::SeedsNotReady)?;
        let p2 = game.p2_seed_reveal.clone().ok_or(Error::SeedsNotReady)?;

        let session_seed = derive_session_seed(&env, session_id, &p1, &p2);

        let now = env.ledger().timestamp();
        let deadline = now + GAME_SECONDS;

        // Compute initial state commitment with the provided commitments.
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
            deadline,
        );

        game.session_seed = Some(session_seed);
        game.map_commitment = map_commitment;
        game.player1_pos_commit = p1_pos_commit;
        game.player2_pos_commit = p2_pos_commit;
        game.loot_total_collected = 0;
        game.state_commitment = state_commitment;
        game.started_at_ts = Some(now);
        game.deadline_ts = Some(deadline);
        game.status = GameStatus::Active;
        game.active_player = game.player1.clone();
        game.turn_index = 0;

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    /// Verifies a Groth16 ZK turn proof and applies the proven state transition.
    ///
    /// The Circom circuit proves (privately, over BN254 with Poseidon):
    ///   - pos_commit_before = Poseidon3(pos_x, pos_y, pos_nonce)
    ///   - pos_commit_after  = Poseidon3(end_x, end_y, new_nonce)
    ///   - Path is valid (adjacency, bounds, no walls)
    ///   - loot_delta is correctly computed from the path
    ///   - score_delta = loot_delta − camera_hits − laser_hits * 2
    ///
    /// The single public input is pi_hash (Poseidon-based), embedded at
    /// proof_blob[4..36]. The contract verifies this binding before calling
    /// the Groth16 verifier.
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
        if game.deadline_ts.unwrap_or(0) <= env.ledger().timestamp() {
            Self::end_if_finished(env.clone(), session_id)?;
            return Err(Error::TimerExpired);
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

        // Groth16 proof blob: [4 n_pub=1][32 pi_hash][64 pi_a][128 pi_b][64 pi_c] = 292 bytes
        if proof_blob.len() < 292 {
            return Err(Error::ProofRequired);
        }

        // Verify pos_commit_before matches stored commitment for the active player.
        let expected_pos_commit_before = if player == game.player1 {
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

        let player_tag: u32 = if player == game.player1 { 1 } else { 2 };

        // Compute the expected pi_hash from public turn data.
        // The Circom circuit must compute this identically as its single public input.
        // Formula: Poseidon2(
        //   Poseidon4(session_id, turn_index, player_tag, pos_commit_before),
        //   Poseidon4(pos_commit_after, score_delta_fr, loot_delta, no_path_flag)
        // )
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

        // Call the ZK verifier — proof_blob contains public inputs + proof bytes.
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierAddress)
            .expect("verifier missing");
        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        let proof_id = verifier.verify_proof_with_stored_vk(&proof_blob);

        // Apply proven state changes.
        if player == game.player1 {
            game.player1_score = game
                .player1_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            game.player1_pos_commit = public_turn.pos_commit_after.clone();
            game.active_player = game.player2.clone();
        } else {
            game.player2_score = game
                .player2_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            game.player2_pos_commit = public_turn.pos_commit_after.clone();
            game.active_player = game.player1.clone();
        }

        game.loot_total_collected = game
            .loot_total_collected
            .saturating_add(public_turn.loot_delta);
        game.turn_index += 1;
        game.state_commitment = public_turn.state_commit_after.clone();
        game.last_proof_id = Some(proof_id.clone());

        Self::save_game(&env, session_id, &game);
        env.events()
            .publish((symbol_short!("turn"), session_id), proof_id);

        Self::end_if_finished(env.clone(), session_id)?;
        Ok(())
    }

    /// Ends the game when timeout or full loot collection is reached.
    pub fn end_if_finished(env: Env, session_id: u32) -> Result<(), Error> {
        let mut game = Self::require_game(&env, session_id)?;

        if game.status == GameStatus::Ended {
            return Ok(());
        }

        let deadline = game.deadline_ts.unwrap_or(u64::MAX);
        let timeout = env.ledger().timestamp() >= deadline;
        let all_loot_collected = game.loot_total_collected >= LOOT_COUNT;

        if !timeout && !all_loot_collected {
            return Ok(());
        }

        let player1_won = game.player1_score >= game.player2_score;
        let winner = if player1_won {
            game.player1.clone()
        } else {
            game.player2.clone()
        };

        game.status = GameStatus::Ended;
        game.winner = Some(winner);
        Self::save_game(&env, session_id, &game);

        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("hub missing");
        let hub = GameHubClient::new(&env, &hub_addr);
        hub.end_game(&session_id, &player1_won);

        env.events().publish(
            (symbol_short!("ended"), session_id),
            (game.player1_score, game.player2_score, player1_won),
        );

        Ok(())
    }

    /// Returns the full committed game state. Admin-only.
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
            deadline_ts: game.deadline_ts,
            turn_index: game.turn_index,
            active_player: game.active_player,
            player1_score: game.player1_score,
            player2_score: game.player2_score,
            loot_total_collected: game.loot_total_collected,
            map_commitment: game.map_commitment,
            player1_pos_commit: game.player1_pos_commit,
            player2_pos_commit: game.player2_pos_commit,
            p1_map_seed_commit: game.p1_map_seed_commit,
            p2_map_seed_commit: game.p2_map_seed_commit,
            state_commitment: game.state_commitment,
            winner: game.winner,
            last_proof_id: game.last_proof_id,
        })
    }

    /// Returns the current state commitment (used by clients to build turn proofs).
    pub fn get_state_commitment(env: Env, session_id: u32) -> Result<BytesN<32>, Error> {
        let game = Self::require_game(&env, session_id)?;
        Ok(game.state_commitment.clone())
    }

    /// Returns the deterministic dice value for the current turn.
    /// Clients and the ZK prover use this to know what rolled value to prove.
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
        let session_seed = game.session_seed.ok_or(Error::SeedsNotReady)?;
        Ok(roll_value(&env, session_seed, game.turn_index, player_tag))
    }

    /// Returns the pi_hash that the Circom circuit must produce as its public input.
    /// Useful for client-side proof construction validation.
    pub fn compute_pi_hash(env: Env, session_id: u32, public_turn: TurnZkPublic) -> Result<BytesN<32>, Error> {
        let game = Self::require_game(&env, session_id)?;
        let player_tag: u32 = if public_turn.player == game.player1 { 1 } else { 2 };
        Ok(compute_turn_pi_hash(
            &env,
            session_id,
            public_turn.turn_index,
            player_tag,
            &public_turn.pos_commit_before,
            &public_turn.pos_commit_after,
            public_turn.score_delta,
            public_turn.loot_delta,
            public_turn.no_path_flag,
        ))
    }

    /// Returns the Poseidon-based position commitment for the given (x, y, nonce).
    /// Mirrors the Circom circuit's pos_commit computation.
    pub fn compute_pos_commit_view(env: Env, x: u32, y: u32, nonce: BytesN<32>) -> BytesN<32> {
        compute_pos_commit(&env, x, y, &nonce)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin missing")
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

    pub fn get_hub(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("hub missing")
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

    pub fn get_verifier(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::VerifierAddress)
            .expect("verifier missing")
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
