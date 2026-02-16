#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, BytesN, Env,
};

use crate::{GameStatus, HeistContract, HeistContractClient};

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
    pub fn verify_proof_with_stored_vk(env: Env, proof_blob: soroban_sdk::Bytes) -> BytesN<32> {
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
