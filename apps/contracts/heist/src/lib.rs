#![no_std]

mod engine;

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short,
    vec, Address, Bytes, BytesN, Env, IntoVal, Vec,
};
use soroban_sdk::xdr::ToXdr;

use engine::{
    bit_is_set, bit_set, commit_hash, compute_state_hash, derive_session_seed, exists_any_path_len,
    from_arr18, generate_map, has_any_set_bit, is_full_collection, reveal_fog_4x4,
    roll_value, to_arr18, zero_bitset, BITSET_BYTES, CAMERA_PENALTY, CELL_COUNT, GAME_SECONDS,
    LASER_PENALTY, MAP_H, MAP_W,
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
    fn verify_proof_with_stored_vk(
        env: Env,
        proof_blob: Bytes,
        public_inputs_hash: BytesN<32>,
    ) -> BytesN<32>;
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
    pub path: Vec<Position>,
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerGameView {
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
    pub loot_collected: BytesN<18>,
    pub visible_walls: BytesN<18>,
    pub visible_loot: BytesN<18>,
    pub visible_cameras: Vec<Camera>,
    pub visible_lasers: Vec<Laser>,
    pub my_fog: BytesN<18>,
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
        game.player1.require_auth();
        game.player2.require_auth();

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
                || public_turn.path.len() != 1
                || public_turn.path.get(0).unwrap_or(Position { x: 0, y: 0 })
                    != public_turn.start_pos
            {
                return Err(Error::InvalidNoPathFlag);
            }
            // With partial-move rules, no_path_flag is valid only when even a
            // single step is impossible (player is fully surrounded by walls).
            if exists_any_path_len(&walls, &current_pos, 1) {
                return Err(Error::InvalidNoPathFlag);
            }
        } else {
            if !Self::validate_path(&walls, &public_turn.path, rolled) {
                return Err(Error::InvalidMoveLength);
            }
            let path_end = public_turn
                .path
                .get(public_turn.path.len() - 1)
                .unwrap_or(Position { x: 0, y: 0 });
            if path_end != public_turn.end_pos {
                return Err(Error::InvalidMoveLength);
            }
        }

        let expected_turn_hash = Self::compute_turn_public_hash(&env, &public_turn);
        let verifier_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::VerifierAddress)
            .expect("verifier missing");
        let verifier = ZkVerifierClient::new(&env, &verifier_addr);
        let proof_id = verifier.verify_proof_with_stored_vk(&proof_blob, &expected_turn_hash);

        let loot_delta = if public_turn.no_path_flag {
            [0u8; 18]
        } else {
            Self::collect_loot_delta_from_path(&game.loot, &game.loot_collected, &public_turn.path)
        };
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

        let (expected_camera_hits, expected_laser_hits) = if public_turn.no_path_flag {
            (0u32, 0u32)
        } else {
            Self::compute_hazard_hits(&public_turn.path, &game.cameras, &game.lasers)
        };
        if public_turn.camera_hits != expected_camera_hits || public_turn.laser_hits != expected_laser_hits {
            return Err(Error::InvalidTurnData);
        }

        if public_turn.loot_collected_mask_delta != from_arr18(&env, &loot_delta) {
            return Err(Error::InvalidTurnData);
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
            game.player1_score = game
                .player1_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            let mut fog = to_arr18(&game.fog_p1);
            reveal_fog_4x4(&mut fog, game.player1_pos.x, game.player1_pos.y);
            game.fog_p1 = from_arr18(&env, &fog);
            game.active_player = game.player2.clone();
        } else {
            game.player2_pos = public_turn.end_pos.clone();
            game.player2_score = game
                .player2_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
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

    /// Returns a player-scoped game view constrained by fog-of-war.
    pub fn get_player_view(
        env: Env,
        session_id: u32,
        player: Address,
    ) -> Result<PlayerGameView, Error> {
        player.require_auth();
        let game = Self::require_game(&env, session_id)?;

        let my_fog = if player == game.player1 {
            game.fog_p1.clone()
        } else if player == game.player2 {
            game.fog_p2.clone()
        } else {
            return Err(Error::NotPlayer);
        };
        let fog = to_arr18(&my_fog);
        let walls = to_arr18(&game.walls);
        let loot = to_arr18(&game.loot);

        let mut visible_walls = [0u8; 18];
        let mut visible_loot = [0u8; 18];
        let mut i = 0u32;
        while i < CELL_COUNT {
            if bit_is_set(&fog, i) {
                if bit_is_set(&walls, i) {
                    bit_set(&mut visible_walls, i);
                }
                if bit_is_set(&loot, i) {
                    bit_set(&mut visible_loot, i);
                }
            }
            i += 1;
        }

        // A camera is visible when its influence area (radius) intersects the fog.
        // This ensures that cameras just outside the revealed area are shown when
        // their detection zone overlaps cells the player has already uncovered.
        let mut visible_cameras = Vec::new(&env);
        let mut ci = 0u32;
        while ci < game.cameras.len() {
            let cam = game.cameras.get(ci).unwrap();
            if Self::camera_intersects_fog(&cam, &fog) {
                visible_cameras.push_back(cam);
            }
            ci += 1;
        }

        let mut visible_lasers = Vec::new(&env);
        let mut li = 0u32;
        while li < game.lasers.len() {
            let laser = game.lasers.get(li).unwrap();
            if Self::laser_intersects_fog(&laser, &fog) {
                visible_lasers.push_back(laser);
            }
            li += 1;
        }

        Ok(PlayerGameView {
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
            loot_collected: game.loot_collected,
            visible_walls: from_arr18(&env, &visible_walls),
            visible_loot: from_arr18(&env, &visible_loot),
            visible_cameras,
            visible_lasers,
            my_fog,
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

    /// Returns the deterministic dice value expected for the requested player at current turn index.
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

    /// Exposes the canonical public-turn hash used by proof verification.
    pub fn hash_turn_public(env: Env, turn: TurnPublic) -> BytesN<32> {
        Self::compute_turn_public_hash(&env, &turn)
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
            game.player1_score = game
                .player1_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            game.active_player = game.player2.clone();
            let mut fog = to_arr18(&game.fog_p1);
            reveal_fog_4x4(&mut fog, game.player1_pos.x, game.player1_pos.y);
            game.fog_p1 = from_arr18(&env, &fog);
        } else {
            game.player2_pos = public_turn.end_pos.clone();
            game.player2_score = game
                .player2_score
                .checked_add(public_turn.score_delta)
                .ok_or(Error::InvalidScoreDelta)?;
            game.active_player = game.player1.clone();
            let mut fog = to_arr18(&game.fog_p2);
            reveal_fog_4x4(&mut fog, game.player2_pos.x, game.player2_pos.y);
            game.fog_p2 = from_arr18(&env, &fog);
        }

        game.turn_index += 1;
        Ok(compute_state_hash(&env, session_id, &game))
    }

    /// Returns the loot-collected mask delta the contract would compute for a
    /// given path.  Clients call this right before building a turn so the
    /// submitted `loot_collected_mask_delta` always reflects the *current*
    /// on-chain state — not a potentially-stale cached view.
    /// Returns an error if any path cell already has its loot collected
    /// (mirrors the same check in `submit_turn`).
    pub fn get_path_loot_delta(
        env: Env,
        session_id: u32,
        path: Vec<Position>,
    ) -> Result<BytesN<18>, Error> {
        let game = Self::require_game(&env, session_id)?;
        let delta =
            Self::collect_loot_delta_from_path(&game.loot, &game.loot_collected, &path);
        Ok(from_arr18(&env, &delta))
    }

    /// Returns the (camera_hits, laser_hits) the contract would compute for a
    /// given path. Callable by anyone — clients use this to build valid turns
    /// without needing full game-state access (fog-of-war limitation).
    pub fn get_path_hazards(
        env: Env,
        session_id: u32,
        path: Vec<Position>,
    ) -> Result<(u32, u32), Error> {
        let game = Self::require_game(&env, session_id)?;
        let (cam_hits, laser_hits) =
            Self::compute_hazard_hits(&path, &game.cameras, &game.lasers);
        Ok((cam_hits, laser_hits))
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

    fn validate_path(walls: &[u8; 18], path: &Vec<Position>, rolled: u32) -> bool {
        // Partial-move rule: the player may stop anywhere after 1..=rolled steps.
        // path includes the start position, so valid length is 2..=rolled+1.
        if path.len() < 2 || path.len() > rolled + 1 {
            return false;
        }
        let mut i = 0u32;
        while i < path.len() {
            let p = path.get(i).unwrap();
            if p.x >= MAP_W || p.y >= MAP_H {
                return false;
            }
            if bit_is_set(walls, p.y * MAP_W + p.x) {
                return false;
            }
            if i > 0 {
                let prev = path.get(i - 1).unwrap();
                let dx = if p.x > prev.x { p.x - prev.x } else { prev.x - p.x };
                let dy = if p.y > prev.y { p.y - prev.y } else { prev.y - p.y };
                if dx + dy != 1 {
                    return false;
                }
            }
            i += 1;
        }
        true
    }

    fn collect_loot_delta_from_path(
        loot: &BytesN<18>,
        loot_collected: &BytesN<18>,
        path: &Vec<Position>,
    ) -> [u8; 18] {
        let loot_arr = to_arr18(loot);
        let collected_arr = to_arr18(loot_collected);
        let mut delta = [0u8; 18];

        let mut i = 0u32;
        while i < path.len() {
            let p = path.get(i).unwrap();
            let bit = p.y * MAP_W + p.x;
            // A cell whose loot is already collected can still be traversed —
            // just skip it (no delta entry).  The error is only raised below
            // when the *submitted* delta explicitly claims already-taken loot.
            if bit_is_set(&loot_arr, bit) && !bit_is_set(&collected_arr, bit) {
                bit_set(&mut delta, bit);
            }
            i += 1;
        }
        delta
    }

    fn compute_hazard_hits(path: &Vec<Position>, cameras: &Vec<Camera>, lasers: &Vec<Laser>) -> (u32, u32) {
        let mut camera_hits = 0u32;
        let mut ci = 0u32;
        while ci < cameras.len() {
            let cam = cameras.get(ci).unwrap();
            if Self::path_hits_camera(path, &cam) {
                camera_hits += 1;
            }
            ci += 1;
        }

        let mut laser_hits = 0u32;
        let mut li = 0u32;
        while li < lasers.len() {
            let laser = lasers.get(li).unwrap();
            if Self::path_hits_laser(path, &laser) {
                laser_hits += 1;
            }
            li += 1;
        }

        (camera_hits, laser_hits)
    }

    fn path_hits_camera(path: &Vec<Position>, camera: &Camera) -> bool {
        let mut i = 0u32;
        while i < path.len() {
            let p = path.get(i).unwrap();
            let dx = if p.x > camera.x { p.x - camera.x } else { camera.x - p.x };
            let dy = if p.y > camera.y { p.y - camera.y } else { camera.y - p.y };
            if dx + dy <= camera.radius {
                return true;
            }
            i += 1;
        }
        false
    }

    fn path_hits_laser(path: &Vec<Position>, laser: &Laser) -> bool {
        let mut i = 0u32;
        while i < path.len() {
            let p = path.get(i).unwrap();
            if laser.x1 == laser.x2 {
                if p.x == laser.x1 && p.y >= laser.y1 && p.y <= laser.y2 {
                    return true;
                }
            } else if laser.y1 == laser.y2 && p.y == laser.y1 && p.x >= laser.x1 && p.x <= laser.x2 {
                return true;
            }
            i += 1;
        }
        false
    }

    /// Returns true when any cell within the camera's manhattan-distance radius
    /// is inside the player fog. Used to reveal cameras whose detection zone
    /// overlaps the fog even though their origin cell is outside it.
    fn camera_intersects_fog(camera: &Camera, fog: &[u8; BITSET_BYTES]) -> bool {
        let cx = camera.x as i32;
        let cy = camera.y as i32;
        let r = camera.radius as i32;
        let mut di = -r;
        while di <= r {
            let rem = r - if di < 0 { -di } else { di };
            let mut dj = -rem;
            while dj <= rem {
                let nx = cx + di;
                let ny = cy + dj;
                if nx >= 0 && ny >= 0 && (nx as u32) < MAP_W && (ny as u32) < MAP_H {
                    if bit_is_set(fog, (ny as u32) * MAP_W + (nx as u32)) {
                        return true;
                    }
                }
                dj += 1;
            }
            di += 1;
        }
        false
    }

    fn laser_intersects_fog(laser: &Laser, fog: &[u8; 18]) -> bool {
        if laser.x1 == laser.x2 {
            let x = laser.x1;
            let mut y = laser.y1;
            while y <= laser.y2 {
                if bit_is_set(fog, y * MAP_W + x) {
                    return true;
                }
                if y == u32::MAX {
                    break;
                }
                y += 1;
            }
            return false;
        }

        if laser.y1 == laser.y2 {
            let y = laser.y1;
            let mut x = laser.x1;
            while x <= laser.x2 {
                if bit_is_set(fog, y * MAP_W + x) {
                    return true;
                }
                if x == u32::MAX {
                    break;
                }
                x += 1;
            }
            return false;
        }

        false
    }

    fn compute_turn_public_hash(env: &Env, turn: &TurnPublic) -> BytesN<32> {
        let mut b = Bytes::new(env);
        b.append(&Bytes::from_array(env, &turn.session_id.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.turn_index.to_be_bytes()));
        b.append(&turn.player.clone().to_xdr(env));
        b.append(&Bytes::from_array(env, &turn.start_pos.x.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.start_pos.y.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.end_pos.x.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.end_pos.y.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.rolled_value.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.score_delta.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.camera_hits.to_be_bytes()));
        b.append(&Bytes::from_array(env, &turn.laser_hits.to_be_bytes()));
        b.append(&Bytes::from(turn.loot_collected_mask_delta.clone()));
        b.push_back(if turn.no_path_flag { 1 } else { 0 });
        b.append(&Bytes::from(turn.state_hash_before.clone()));
        b.append(&Bytes::from(turn.state_hash_after.clone()));

        let mut i = 0u32;
        while i < turn.path.len() {
            let p = turn.path.get(i).unwrap();
            b.append(&Bytes::from_array(env, &p.x.to_be_bytes()));
            b.append(&Bytes::from_array(env, &p.y.to_be_bytes()));
            i += 1;
        }
        env.crypto().keccak256(&b).into()
    }
}

#[cfg(test)]
mod test;
