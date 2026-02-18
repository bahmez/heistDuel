#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, BytesN, Env, Vec,
};

use crate::{
    engine::{derive_session_seed, roll_value},
    GameStatus, HeistContract, HeistContractClient, Position, TurnPublic,
};

#[contract]
pub struct MockHubContract;

#[contracttype]
#[derive(Clone)]
enum HubDataKey {
    Ended(u32),
    Player1Won(u32),
}

#[contractimpl]
impl MockHubContract {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
    }

    pub fn end_game(env: Env, session_id: u32, player1_won: bool) {
        env.storage()
            .instance()
            .set(&HubDataKey::Ended(session_id), &true);
        env.storage()
            .instance()
            .set(&HubDataKey::Player1Won(session_id), &player1_won);
    }

    pub fn ended(env: Env, session_id: u32) -> bool {
        env.storage()
            .instance()
            .get(&HubDataKey::Ended(session_id))
            .unwrap_or(false)
    }

    pub fn player1_won(env: Env, session_id: u32) -> bool {
        env.storage()
            .instance()
            .get(&HubDataKey::Player1Won(session_id))
            .unwrap_or(false)
    }
}

#[contract]
pub struct MockVerifierContract;

#[contractimpl]
impl MockVerifierContract {
    pub fn verify_proof_with_stored_vk(
        env: Env,
        proof_blob: soroban_sdk::Bytes,
        _public_inputs_hash: BytesN<32>,
    ) -> BytesN<32> {
        env.crypto().keccak256(&proof_blob).into()
    }
}

fn make_commit(env: &Env, seed: &BytesN<32>) -> BytesN<32> {
    let mut b = soroban_sdk::Bytes::new(env);
    b.append(&soroban_sdk::Bytes::from(seed.clone()));
    env.crypto().keccak256(&b).into()
}

#[test]
fn start_reveal_begin_flow() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    let hub_id = env.register(MockHubContract, ());
    let verifier_id = env.register(MockVerifierContract, ());
    let heist_id = env.register(
        HeistContract,
        (admin.clone(), hub_id.clone(), verifier_id.clone()),
    );

    let heist = HeistContractClient::new(&env, &heist_id);

    let session_id = 100u32;
    let s1 = BytesN::from_array(&env, &[1u8; 32]);
    let s2 = BytesN::from_array(&env, &[2u8; 32]);
    let c1 = make_commit(&env, &s1);
    let c2 = make_commit(&env, &s2);

    heist.start_game(&session_id, &player1, &player2, &50, &50, &c1, &c2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);
    heist.begin_match(&session_id);

    let g = heist.get_game(&session_id);
    assert_eq!(g.status, GameStatus::Active);
    assert_eq!(g.active_player, player1);
}

#[test]
fn tie_break_player1_on_timeout() {
    use soroban_sdk::testutils::Ledger;

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    let hub_id = env.register(MockHubContract, ());
    let hub = MockHubContractClient::new(&env, &hub_id);
    let verifier_id = env.register(MockVerifierContract, ());
    let heist_id = env.register(
        HeistContract,
        (admin.clone(), hub_id.clone(), verifier_id.clone()),
    );

    let heist = HeistContractClient::new(&env, &heist_id);

    let session_id = 101u32;
    let s1 = BytesN::from_array(&env, &[3u8; 32]);
    let s2 = BytesN::from_array(&env, &[4u8; 32]);
    let c1 = make_commit(&env, &s1);
    let c2 = make_commit(&env, &s2);

    heist.start_game(&session_id, &player1, &player2, &50, &50, &c1, &c2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);
    heist.begin_match(&session_id);

    env.ledger().with_mut(|li| {
        li.timestamp += 301;
    });

    heist.end_if_finished(&session_id);

    let g = heist.get_game(&session_id);
    assert_eq!(g.status, GameStatus::Ended);
    assert_eq!(g.winner, Some(player1));
    assert!(hub.ended(&session_id));
    assert!(hub.player1_won(&session_id));
}

#[test]
fn expected_roll_matches_engine_formula() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);

    let hub_id = env.register(MockHubContract, ());
    let verifier_id = env.register(MockVerifierContract, ());
    let heist_id = env.register(
        HeistContract,
        (admin.clone(), hub_id.clone(), verifier_id.clone()),
    );
    let heist = HeistContractClient::new(&env, &heist_id);

    let session_id = 102u32;
    let s1 = BytesN::from_array(&env, &[5u8; 32]);
    let s2 = BytesN::from_array(&env, &[6u8; 32]);
    let c1 = make_commit(&env, &s1);
    let c2 = make_commit(&env, &s2);

    heist.start_game(&session_id, &player1, &player2, &10, &10, &c1, &c2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);
    heist.begin_match(&session_id);

    let session_seed = derive_session_seed(&env, session_id, &s1, &s2);
    let expected_p1 = env.as_contract(&heist_id, || roll_value(&env, session_seed.clone(), 0, 1));
    let expected_p2 = env.as_contract(&heist_id, || roll_value(&env, session_seed, 0, 2));

    let got_p1 = heist.get_expected_roll(&session_id, &player1);
    let got_p2 = heist.get_expected_roll(&session_id, &player2);
    assert_eq!(got_p1, expected_p1);
    assert_eq!(got_p2, expected_p2);
}

#[test]
fn hash_turn_public_is_stable_and_changes_on_input_update() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let player = Address::generate(&env);
    let hub_id = env.register(MockHubContract, ());
    let verifier_id = env.register(MockVerifierContract, ());
    let heist_id = env.register(
        HeistContract,
        (admin.clone(), hub_id.clone(), verifier_id.clone()),
    );
    let heist = HeistContractClient::new(&env, &heist_id);

    let mut path = Vec::new(&env);
    path.push_back(Position { x: 1, y: 1 });
    path.push_back(Position { x: 2, y: 1 });
    let turn = TurnPublic {
        session_id: 200,
        turn_index: 0,
        player: player.clone(),
        start_pos: Position { x: 1, y: 1 },
        end_pos: Position { x: 2, y: 1 },
        rolled_value: 1,
        score_delta: 0,
        camera_hits: 0,
        laser_hits: 0,
        loot_collected_mask_delta: BytesN::from_array(&env, &[0u8; 18]),
        no_path_flag: false,
        state_hash_before: BytesN::from_array(&env, &[1u8; 32]),
        state_hash_after: BytesN::from_array(&env, &[2u8; 32]),
        path,
    };

    let h1 = heist.hash_turn_public(&turn);
    let h2 = heist.hash_turn_public(&turn);
    assert_eq!(h1, h2);

    let mut changed = turn.clone();
    changed.turn_index = 1;
    let h3 = heist.hash_turn_public(&changed);
    assert_ne!(h1, h3);
}
