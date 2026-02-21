use soroban_sdk::{Bytes, BytesN, Env};

pub const GAME_SECONDS: u64 = 300;
pub const LOOT_COUNT: u32 = 24;

/// Commitment to a seed: keccak256(seed).
pub fn commit_hash(env: &Env, seed_secret: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(seed_secret.clone()));
    env.crypto().keccak256(&b).into()
}

/// Derives the public session seed from session_id and both player seed secrets.
/// This seed is used exclusively for dice rolling (it becomes public after begin_match).
pub fn derive_session_seed(env: &Env, session_id: u32, s1: &BytesN<32>, s2: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    b.append(&Bytes::from(s1.clone()));
    b.append(&Bytes::from(s2.clone()));
    env.crypto().keccak256(&b).into()
}

/// Deterministic dice PRNG using pure keccak256.
/// Returns a value in 1..=6.
/// Uses only keccak (no env.prng()) so the formula is exactly reproducible
/// inside a Noir circuit: keccak(session_seed ‖ turn_index ‖ player_tag)[0] % 6 + 1.
pub fn roll_value(env: &Env, session_seed: BytesN<32>, turn_index: u32, player_tag: u32) -> u32 {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(session_seed));
    b.append(&Bytes::from_array(env, &turn_index.to_be_bytes()));
    b.append(&Bytes::from_array(env, &player_tag.to_be_bytes()));
    let h: BytesN<32> = env.crypto().keccak256(&b).into();
    (h.get(0).unwrap_or(0) % 6 + 1) as u32
}

/// Commitment to a player position: keccak256(x ‖ y ‖ nonce).
/// The nonce is kept private by the player and never posted on-chain.
/// Used by the off-chain client/prover to generate pos_commit values.
#[allow(dead_code)]
pub fn compute_pos_commit(env: &Env, x: u32, y: u32, nonce: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &x.to_be_bytes()));
    b.append(&Bytes::from_array(env, &y.to_be_bytes()));
    b.append(&Bytes::from(nonce.clone()));
    env.crypto().keccak256(&b).into()
}

/// State commitment over all publicly committed on-chain values.
///
/// This replaces the old compute_state_hash which included raw map/pos data.
/// The new version only hashes commitment values so the map and positions
/// remain hidden while the state chain remains verifiable.
///
/// Must match exactly what the Noir circuit computes as state_commit_before/after.
pub fn compute_state_commitment(
    env: &Env,
    session_id: u32,
    turn_index: u32,
    player1_score: i128,
    player2_score: i128,
    map_commitment: &BytesN<32>,
    player1_pos_commit: &BytesN<32>,
    player2_pos_commit: &BytesN<32>,
    session_seed: &BytesN<32>,
    deadline_ts: u64,
) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    b.append(&Bytes::from_array(env, &turn_index.to_be_bytes()));
    b.append(&Bytes::from_array(env, &player1_score.to_be_bytes()));
    b.append(&Bytes::from_array(env, &player2_score.to_be_bytes()));
    b.append(&Bytes::from(map_commitment.clone()));
    b.append(&Bytes::from(player1_pos_commit.clone()));
    b.append(&Bytes::from(player2_pos_commit.clone()));
    b.append(&Bytes::from(session_seed.clone()));
    b.append(&Bytes::from_array(env, &deadline_ts.to_be_bytes()));
    env.crypto().keccak256(&b).into()
}

/// Computes the single public-input hash for the ZK turn validity proof.
///
/// The Noir circuit has exactly ONE public input (pi_hash) which is
/// keccak256 of all public turn data. Both the Soroban contract and the
/// Noir circuit must compute this identically.
///
/// The first byte of the keccak output is zeroed to ensure the value fits
/// within the BN254 field prime (< 2^254). This is safe because the
/// remaining 31 bytes (248 bits) are still cryptographically binding.
pub fn compute_turn_pi_hash(
    env: &Env,
    session_id: u32,
    turn_index: u32,
    player_tag: u32,
    p1_map_seed_commit: &BytesN<32>,
    p2_map_seed_commit: &BytesN<32>,
    map_commitment: &BytesN<32>,
    pos_commit_before: &BytesN<32>,
    pos_commit_after: &BytesN<32>,
    state_commit_before: &BytesN<32>,
    state_commit_after: &BytesN<32>,
    score_delta: i128,
    loot_delta: u32,
    no_path_flag: bool,
) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    b.append(&Bytes::from_array(env, &turn_index.to_be_bytes()));
    b.append(&Bytes::from_array(env, &player_tag.to_be_bytes()));
    b.append(&Bytes::from(p1_map_seed_commit.clone()));
    b.append(&Bytes::from(p2_map_seed_commit.clone()));
    b.append(&Bytes::from(map_commitment.clone()));
    b.append(&Bytes::from(pos_commit_before.clone()));
    b.append(&Bytes::from(pos_commit_after.clone()));
    b.append(&Bytes::from(state_commit_before.clone()));
    b.append(&Bytes::from(state_commit_after.clone()));
    b.append(&Bytes::from_array(env, &score_delta.to_be_bytes()));
    b.append(&Bytes::from_array(env, &loot_delta.to_be_bytes()));
    b.push_back(if no_path_flag { 1 } else { 0 });
    let raw: BytesN<32> = env.crypto().keccak256(&b).into();
    // Zero the first byte to guarantee the value fits in BN254 field.
    let mut arr = [0u8; 32];
    let mut i = 0u32;
    while i < 32 {
        arr[i as usize] = raw.get(i).unwrap_or(0);
        i += 1;
    }
    arr[0] = 0;
    BytesN::from_array(env, &arr)
}
