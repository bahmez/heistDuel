#![no_std]

mod engine;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short,
    vec, Address, Bytes, BytesN, Env, IntoVal, Vec,
};

use engine::{
    bit_is_set, bit_set, commit_hash, compute_state_hash, derive_session_seed, exists_any_path_len,
    exists_path_exact_len, from_arr18, generate_map, has_any_set_bit, is_full_collection, reveal_fog_4x4,
    roll_value, to_arr18, zero_bitset, CAMERA_PENALTY, CELL_COUNT, GAME_SECONDS, LASER_PENALTY, MAP_H,
    MAP_W,
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
    InvalidMoveLength = 10,
    InvalidNoPathFlag = 11,
    InvalidScoreDelta = 12,
    LootAlreadyCollected = 13,
    LootOutOfBounds = 14,
    StateHashMismatch = 15,
    TimerExpired = 16,
    InvalidStatus = 17,
    ProofRequired = 18,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub x: u32,
    pub y: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Camera {
    pub x: u32,
    pub y: u32,
    pub radius: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Laser {
    pub x1: u32,
    pub y1: u32,
    pub x2: u32,
    pub y2: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GameStatus {
    WaitingReveal,
    Active,
    Ended,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnPublic {
    pub session_id: u32,
    pub turn_index: u32,
    pub player: Address,
    pub start_pos: Position,
    pub end_pos: Position,
    pub rolled_value: u32,
    pub score_delta: i128,
    pub camera_hits: u32,
    pub laser_hits: u32,
    pub loot_collected_mask_delta: BytesN<18>,
    pub no_path_flag: bool,
    pub state_hash_before: BytesN<32>,
    pub state_hash_after: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub status: GameStatus,
    pub p1_seed_commit: BytesN<32>,
    pub p2_seed_commit: BytesN<32>,
    pub p1_seed_reveal: Option<BytesN<32>>,
    pub p2_seed_reveal: Option<BytesN<32>>,
    pub session_seed: Option<BytesN<32>>,
    pub started_at_ts: Option<u64>,
    pub deadline_ts: Option<u64>,
    pub turn_index: u32,
    pub active_player: Address,
    pub player1_pos: Position,
    pub player2_pos: Position,
    pub player1_score: i128,
    pub player2_score: i128,
    pub walls: BytesN<18>,
    pub loot: BytesN<18>,
    pub loot_collected: BytesN<18>,
    pub fog_p1: BytesN<18>,
    pub fog_p2: BytesN<18>,
    pub cameras: Vec<Camera>,
    pub lasers: Vec<Laser>,
    pub winner: Option<Address>,
    pub last_proof_id: Option<BytesN<32>>,
}

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
    pub player1_pos: Position,
    pub player2_pos: Position,
    pub player1_score: i128,
    pub player2_score: i128,
    pub walls: BytesN<18>,
    pub loot: BytesN<18>,
    pub loot_collected: BytesN<18>,
    pub cameras: Vec<Camera>,
    pub lasers: Vec<Laser>,
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

    /// Creates a new 2-player session and locks entry points through Game Hub.
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
        p1_seed_commit: BytesN<32>,
        p2_seed_commit: BytesN<32>,
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
        ]);
        player2.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player2_points.into_val(&env),
            p2_seed_commit.clone().into_val(&env),
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

        let zero = zero_bitset(&env);
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
            started_at_ts: None,
            deadline_ts: None,
            turn_index: 0,
            active_player: player1.clone(),
            player1_pos: Position { x: 1, y: 1 },
            player2_pos: Position {
                x: MAP_W - 2,
                y: MAP_H - 2,
            },
            player1_score: 0,
            player2_score: 0,
            walls: zero.clone(),
            loot: zero.clone(),
            loot_collected: zero.clone(),
            fog_p1: zero.clone(),
            fog_p2: zero,
            cameras: Vec::new(&env),
            lasers: Vec::new(&env),
            winner: None,
            last_proof_id: None,
        };

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    /// Reveals a previously committed seed from a player.
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

    /// Starts the match after both seeds are revealed and initializes deterministic map state.
    pub fn begin_match(env: Env, session_id: u32) -> Result<(), Error> {
        let mut game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::WaitingReveal {
            return Err(Error::InvalidStatus);
        }

        let p1 = game.p1_seed_reveal.clone().ok_or(Error::SeedsNotReady)?;
        let p2 = game.p2_seed_reveal.clone().ok_or(Error::SeedsNotReady)?;

        let session_seed = derive_session_seed(&env, session_id, &p1, &p2);
        let (walls, loot, cameras, lasers) = generate_map(&env, &session_seed);

        game.session_seed = Some(session_seed);
        game.walls = walls;
        game.loot = loot;
        game.loot_collected = zero_bitset(&env);
        game.cameras = cameras;
        game.lasers = lasers;
        game.started_at_ts = Some(env.ledger().timestamp());
        game.deadline_ts = Some(env.ledger().timestamp() + GAME_SECONDS);
        game.status = GameStatus::Active;
        game.active_player = game.player1.clone();
        game.turn_index = 0;

        let mut fog1 = to_arr18(&game.fog_p1);
        let mut fog2 = to_arr18(&game.fog_p2);
        reveal_fog_4x4(&mut fog1, game.player1_pos.x, game.player1_pos.y);
        reveal_fog_4x4(&mut fog2, game.player2_pos.x, game.player2_pos.y);
        game.fog_p1 = from_arr18(&env, &fog1);
        game.fog_p2 = from_arr18(&env, &fog2);

        Self::save_game(&env, session_id, &game);
        Ok(())
    }

    /// Verifies and applies one complete turn transition proven by ZK proof.
    pub fn submit_turn(
        env: Env,
        session_id: u32,
        player: Address,
        proof_blob: Bytes,
        public_turn: TurnPublic,
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
        if proof_blob.len() == 0 {
            return Err(Error::ProofRequired);
        }

        let before_hash = compute_state_hash(&env, session_id, &game);
        if public_turn.state_hash_before != before_hash {
            return Err(Error::StateHashMismatch);
        }

        let current_pos = if player == game.player1 {
            game.player1_pos.clone()
        } else {
            game.player2_pos.clone()
        };

        if public_turn.start_pos != current_pos {
            return Err(Error::InvalidTurnData);
        }

        let rolled = roll_value(
            &env,
            game.session_seed.clone().ok_or(Error::SeedsNotReady)?,
            game.turn_index,
            if player == game.player1 { 1 } else { 2 },
        );
        if rolled != public_turn.rolled_value {
            return Err(Error::InvalidMoveLength);
        }

        let walls = to_arr18(&game.walls);
        if public_turn.no_path_flag {
            if public_turn.start_pos != public_turn.end_pos
                || public_turn.score_delta != 0
                || public_turn.camera_hits != 0
                || public_turn.laser_hits != 0
                || has_any_set_bit(&public_turn.loot_collected_mask_delta)
            {
                return Err(Error::InvalidNoPathFlag);
            }
            if exists_any_path_len(&walls, &current_pos, rolled) {
                return Err(Error::InvalidNoPathFlag);
            }
        } else if !exists_path_exact_len(&walls, &public_turn.start_pos, &public_turn.end_pos, rolled)
        {
            return Err(Error::InvalidMoveLength);
        }

        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierAddress)
            .expect("verifier missing");
        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        let proof_id = verifier.verify_proof_with_stored_vk(&proof_blob);

        let loot_delta = to_arr18(&public_turn.loot_collected_mask_delta);
        let loot = to_arr18(&game.loot);
        let mut collected = to_arr18(&game.loot_collected);

        let mut loot_points: i128 = 0;
        let mut i = 0u32;
        while i < CELL_COUNT {
            if bit_is_set(&loot_delta, i) {
                if !bit_is_set(&loot, i) {
                    return Err(Error::LootOutOfBounds);
                }
                if bit_is_set(&collected, i) {
                    return Err(Error::LootAlreadyCollected);
                }
                bit_set(&mut collected, i);
                loot_points += 1;
            }
            i += 1;
        }

        let expected_delta = loot_points
            - (public_turn.camera_hits as i128) * CAMERA_PENALTY
            - (public_turn.laser_hits as i128) * LASER_PENALTY;
        if expected_delta != public_turn.score_delta {
            return Err(Error::InvalidScoreDelta);
        }

        game.loot_collected = from_arr18(&env, &collected);
        if player == game.player1 {
            game.player1_pos = public_turn.end_pos.clone();
            game.player1_score += public_turn.score_delta;
            let mut fog = to_arr18(&game.fog_p1);
            reveal_fog_4x4(&mut fog, game.player1_pos.x, game.player1_pos.y);
            game.fog_p1 = from_arr18(&env, &fog);
            game.active_player = game.player2.clone();
        } else {
            game.player2_pos = public_turn.end_pos.clone();
            game.player2_score += public_turn.score_delta;
            let mut fog = to_arr18(&game.fog_p2);
            reveal_fog_4x4(&mut fog, game.player2_pos.x, game.player2_pos.y);
            game.fog_p2 = from_arr18(&env, &fog);
            game.active_player = game.player1.clone();
        }

        game.turn_index += 1;
        game.last_proof_id = Some(proof_id.clone());

        let after_hash = compute_state_hash(&env, session_id, &game);
        if after_hash != public_turn.state_hash_after {
            return Err(Error::StateHashMismatch);
        }

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
        let all_loot_collected = is_full_collection(&game.loot, &game.loot_collected);
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

    /// Returns a public view of the game state.
    pub fn get_game(env: Env, session_id: u32) -> Result<GameView, Error> {
        let game = Self::require_game(&env, session_id)?;
        Ok(GameView {
            player1: game.player1,
            player2: game.player2,
            status: game.status,
            started_at_ts: game.started_at_ts,
            deadline_ts: game.deadline_ts,
            turn_index: game.turn_index,
            active_player: game.active_player,
            player1_pos: game.player1_pos,
            player2_pos: game.player2_pos,
            player1_score: game.player1_score,
            player2_score: game.player2_score,
            walls: game.walls,
            loot: game.loot,
            loot_collected: game.loot_collected,
            cameras: game.cameras,
            lasers: game.lasers,
            winner: game.winner,
            last_proof_id: game.last_proof_id,
        })
    }

    /// Returns the caller player's fog-of-war bitset.
    pub fn get_player_fog(env: Env, session_id: u32, player: Address) -> Result<BytesN<18>, Error> {
        player.require_auth();
        let game = Self::require_game(&env, session_id)?;
        if player == game.player1 {
            Ok(game.fog_p1)
        } else if player == game.player2 {
            Ok(game.fog_p2)
        } else {
            Err(Error::NotPlayer)
        }
    }

    /// Exposes the current state hash for client/prover synchronization.
    pub fn get_state_hash(env: Env, session_id: u32) -> Result<BytesN<32>, Error> {
        let game = Self::require_game(&env, session_id)?;
        Ok(compute_state_hash(&env, session_id, &game))
    }

    /// Simulates state transition hashing without touching chain state.
    pub fn simulate_state_hash_after(
        env: Env,
        session_id: u32,
        public_turn: TurnPublic,
    ) -> Result<BytesN<32>, Error> {
        let mut game = Self::require_game(&env, session_id)?;
        if game.status != GameStatus::Active {
            return Err(Error::InvalidStatus);
        }

        let loot_delta = to_arr18(&public_turn.loot_collected_mask_delta);
        let mut collected = to_arr18(&game.loot_collected);
        let mut i = 0u32;
        while i < CELL_COUNT {
            if bit_is_set(&loot_delta, i) {
                bit_set(&mut collected, i);
            }
            i += 1;
        }
        game.loot_collected = from_arr18(&env, &collected);

        if public_turn.player == game.player1 {
            game.player1_pos = public_turn.end_pos.clone();
            game.player1_score += public_turn.score_delta;
            game.active_player = game.player2.clone();
            let mut fog = to_arr18(&game.fog_p1);
            reveal_fog_4x4(&mut fog, game.player1_pos.x, game.player1_pos.y);
            game.fog_p1 = from_arr18(&env, &fog);
        } else {
            game.player2_pos = public_turn.end_pos.clone();
            game.player2_score += public_turn.score_delta;
            game.active_player = game.player1.clone();
            let mut fog = to_arr18(&game.fog_p2);
            reveal_fog_4x4(&mut fog, game.player2_pos.x, game.player2_pos.y);
            game.fog_p2 = from_arr18(&env, &fog);
        }

        game.turn_index += 1;
        Ok(compute_state_hash(&env, session_id, &game))
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
