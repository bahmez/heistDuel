#![cfg(test)]

use soroban_sdk::{
    contract, contractimpl, contracttype, testutils::Address as _, Address, Bytes, BytesN, Env,
};

use crate::{
    engine::{commit_hash, compute_turn_pi_hash, derive_session_seed, roll_value},
    GameStatus, HeistContract, HeistContractClient, TurnZkPublic,
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

/// Mock verifier: matches the actual ZkVerifier trait (no public_inputs_hash param).
/// Returns keccak256(proof_blob) as the proof_id.
#[contract]
pub struct MockVerifierContract;

#[contractimpl]
impl MockVerifierContract {
    pub fn verify_proof_with_stored_vk(
        env: Env,
        proof_blob: Bytes,
    ) -> BytesN<32> {
        env.crypto().keccak256(&proof_blob).into()
    }
}

fn make_commit(env: &Env, seed: &BytesN<32>) -> BytesN<32> {
    commit_hash(env, seed)
}

/// Builds a valid proof_blob stub for testing.
/// Format: [0x00,0x00,0x00,0x01][32 bytes pi_hash][dummy proof bytes]
fn make_test_proof_blob(env: &Env, pi_hash: &BytesN<32>) -> Bytes {
    let mut blob = Bytes::new(env);
    // count = 1 (big-endian u32)
    blob.push_back(0x00);
    blob.push_back(0x00);
    blob.push_back(0x00);
    blob.push_back(0x01);
    // 32 bytes of pi_hash
    let mut k = 0u32;
    while k < 32 {
        blob.push_back(pi_hash.get(k).unwrap_or(0));
        k += 1;
    }
    // Dummy proof bytes: need total >= 292 (4 + 32 + padding).
    let mut p = 0u32;
    while p < 256 {
        blob.push_back(0xAB);
        p += 1;
    }
    blob
}

fn setup_active_game(
    session_id: u32,
) -> (
    Env,
    Address, // player1
    Address, // player2
    Address, // heist_id
    MockHubContractClient<'static>,
    BytesN<32>, // session_seed
    BytesN<32>, // map_commitment (dummy)
    BytesN<32>, // p1_pos_commit (dummy)
    BytesN<32>, // p2_pos_commit (dummy)
) {
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

    let s1 = BytesN::from_array(&env, &[1u8; 32]);
    let s2 = BytesN::from_array(&env, &[2u8; 32]);
    let c1 = make_commit(&env, &s1);
    let c2 = make_commit(&env, &s2);

    // Map seed commitments (secrets stay off-chain)
    let ms1 = BytesN::from_array(&env, &[0xAAu8; 32]);
    let ms2 = BytesN::from_array(&env, &[0xBBu8; 32]);
    let mc1 = make_commit(&env, &ms1);
    let mc2 = make_commit(&env, &ms2);

    heist.start_game(&session_id, &player1, &player2, &50, &50, &c1, &c2, &mc1, &mc2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);

    let map_commitment = BytesN::from_array(&env, &[0x11u8; 32]);
    let p1_pos_commit = BytesN::from_array(&env, &[0x22u8; 32]);
    let p2_pos_commit = BytesN::from_array(&env, &[0x33u8; 32]);

    heist.begin_match(&session_id, &map_commitment, &p1_pos_commit, &p2_pos_commit);

    let session_seed = derive_session_seed(&env, session_id, &s1, &s2);

    // We need to return owned versions — clone into 'static via leaked env trick is not needed;
    // we return them by value since BytesN is Clone.
    (env, player1, player2, heist_id, hub, session_seed, map_commitment, p1_pos_commit, p2_pos_commit)
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
    let mc1 = make_commit(&env, &BytesN::from_array(&env, &[0xAAu8; 32]));
    let mc2 = make_commit(&env, &BytesN::from_array(&env, &[0xBBu8; 32]));

    heist.start_game(&session_id, &player1, &player2, &50, &50, &c1, &c2, &mc1, &mc2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);

    let map_commitment = BytesN::from_array(&env, &[0x11u8; 32]);
    let p1_pos = BytesN::from_array(&env, &[0x22u8; 32]);
    let p2_pos = BytesN::from_array(&env, &[0x33u8; 32]);

    heist.begin_match(&session_id, &map_commitment, &p1_pos, &p2_pos);

    let g = heist.get_game(&session_id);
    assert_eq!(g.status, GameStatus::Active);
    assert_eq!(g.active_player, player1);
    assert_eq!(g.map_commitment, map_commitment);
    assert_eq!(g.player1_pos_commit, p1_pos);
    assert_eq!(g.player2_pos_commit, p2_pos);
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
    let mc1 = make_commit(&env, &BytesN::from_array(&env, &[0xCCu8; 32]));
    let mc2 = make_commit(&env, &BytesN::from_array(&env, &[0xDDu8; 32]));

    heist.start_game(&session_id, &player1, &player2, &50, &50, &c1, &c2, &mc1, &mc2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);

    let map_commitment = BytesN::from_array(&env, &[0x44u8; 32]);
    let p1_pos = BytesN::from_array(&env, &[0x55u8; 32]);
    let p2_pos = BytesN::from_array(&env, &[0x66u8; 32]);
    heist.begin_match(&session_id, &map_commitment, &p1_pos, &p2_pos);

    // Advance past PLAYER_TIME_SECONDS (600s) so p1's clock expires.
    env.ledger().with_mut(|li| {
        li.timestamp += 601;
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
    let mc1 = make_commit(&env, &BytesN::from_array(&env, &[0xEEu8; 32]));
    let mc2 = make_commit(&env, &BytesN::from_array(&env, &[0xFFu8; 32]));

    heist.start_game(&session_id, &player1, &player2, &10, &10, &c1, &c2, &mc1, &mc2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);
    let map_commitment = BytesN::from_array(&env, &[0x77u8; 32]);
    let p1_pos = BytesN::from_array(&env, &[0x88u8; 32]);
    let p2_pos = BytesN::from_array(&env, &[0x99u8; 32]);
    heist.begin_match(&session_id, &map_commitment, &p1_pos, &p2_pos);

    let session_seed = derive_session_seed(&env, session_id, &s1, &s2);
    let expected_p1 = env.as_contract(&heist_id, || roll_value(&env, session_seed.clone(), 0, 1));
    let expected_p2 = env.as_contract(&heist_id, || roll_value(&env, session_seed, 0, 2));

    let got_p1 = heist.get_expected_roll(&session_id, &player1);
    let got_p2 = heist.get_expected_roll(&session_id, &player2);
    assert_eq!(got_p1, expected_p1);
    assert_eq!(got_p2, expected_p2);
}

#[test]
fn submit_turn_updates_state() {
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

    let session_id = 103u32;
    let s1 = BytesN::from_array(&env, &[7u8; 32]);
    let s2 = BytesN::from_array(&env, &[8u8; 32]);
    let c1 = make_commit(&env, &s1);
    let c2 = make_commit(&env, &s2);
    let mc1 = make_commit(&env, &BytesN::from_array(&env, &[0x11u8; 32]));
    let mc2 = make_commit(&env, &BytesN::from_array(&env, &[0x22u8; 32]));

    heist.start_game(&session_id, &player1, &player2, &10, &10, &c1, &c2, &mc1, &mc2);
    heist.reveal_seed(&session_id, &player1, &s1);
    heist.reveal_seed(&session_id, &player2, &s2);

    let map_commitment = BytesN::from_array(&env, &[0xAAu8; 32]);
    // Use zero-prefixed values so they are valid BN254 Fr elements (< field prime starting 0x30).
    let p1_pos_commit = BytesN::from_array(&env, &{let mut a=[0u8;32]; a[31]=0x01; a});
    let p2_pos_commit = BytesN::from_array(&env, &{let mut a=[0u8;32]; a[31]=0x02; a});
    heist.begin_match(&session_id, &map_commitment, &p1_pos_commit, &p2_pos_commit);

    // Get the initial state commitment
    let state_commit_before = heist.get_state_commitment(&session_id);
    let new_pos_commit = BytesN::from_array(&env, &{let mut a=[0u8;32]; a[31]=0x03; a});
    let state_commit_after = BytesN::from_array(&env, &[0xEEu8; 32]);

    // Build the public turn data
    let public_turn = TurnZkPublic {
        session_id,
        turn_index: 0,
        player: player1.clone(),
        score_delta: 1,
        loot_delta: 1,
        loot_mask: 1i128, // bit 0 set = loot cell 0
        pos_commit_before: p1_pos_commit.clone(),
        pos_commit_after: new_pos_commit.clone(),
        state_commit_before: state_commit_before.clone(),
        state_commit_after: state_commit_after.clone(),
        no_path_flag: false,
        exited_flag: false,
    };

    // Compute the pi_hash directly using the engine function (player1 = tag 1)
    let pi_hash = env.as_contract(&heist_id, || {
        compute_turn_pi_hash(
            &env,
            session_id,
            public_turn.turn_index,
            1u32,
            &public_turn.pos_commit_before,
            &public_turn.pos_commit_after,
            public_turn.score_delta,
            public_turn.loot_delta,
            public_turn.no_path_flag,
            public_turn.exited_flag,
        )
    });
    let proof_blob = make_test_proof_blob(&env, &pi_hash);

    heist.submit_turn(&session_id, &player1, &proof_blob, &public_turn);

    let g = heist.get_game(&session_id);
    assert_eq!(g.turn_index, 1);
    assert_eq!(g.player1_score, 1);
    assert_eq!(g.loot_total_collected, 1);
    assert_eq!(g.player1_pos_commit, new_pos_commit);
    assert_eq!(g.state_commitment, state_commit_after);
    assert_eq!(g.active_player, player2);
}
