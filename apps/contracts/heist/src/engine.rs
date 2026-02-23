use soroban_sdk::{crypto::BnScalar, vec, Bytes, BytesN, Env, U256};
use soroban_poseidon::poseidon_hash;

pub const PLAYER_TIME_SECONDS: u64 = 300; // 5 minutes per player (chess clock)
pub const LOOT_COUNT: u32 = 24;

// ── BN254 Fr prime (big-endian) ───────────────────────────────────────────────
// Used to negate field elements (−x ≡ prime − x mod prime).
const BN254_FR_PRIME: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
    0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
    0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

fn bytes32_to_u256(env: &Env, bytes: &BytesN<32>) -> U256 {
    U256::from_be_bytes(env, &bytes.clone().into())
}

fn u256_to_bytes32(_env: &Env, val: &U256) -> BytesN<32> {
    let b: Bytes = val.to_be_bytes();
    BytesN::try_from(b).expect("U256 is 32 bytes")
}

fn u32_to_u256(env: &Env, val: u32) -> U256 {
    U256::from_u32(env, val)
}

/// Represents an i128 as a BN254 Fr element.
/// Non-negative: value as-is. Negative: prime + value (≡ −|value| in Fr).
fn i128_to_u256(env: &Env, val: i128) -> U256 {
    if val >= 0 {
        U256::from_u128(env, val as u128)
    } else {
        let prime = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_FR_PRIME));
        let abs_val = U256::from_u128(env, (-val) as u128);
        prime.sub(&abs_val)
    }
}

// ── Public functions ──────────────────────────────────────────────────────────

/// Commitment to a seed: keccak256(seed).
/// Used for dice seed commit-reveal — NOT ZK-circuit-bound, can stay keccak.
pub fn commit_hash(env: &Env, seed_secret: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(seed_secret.clone()));
    env.crypto().keccak256(&b).into()
}

/// Session seed: keccak256(session_id ‖ s1 ‖ s2).
/// Not ZK-bound, stays keccak.
pub fn derive_session_seed(env: &Env, session_id: u32, s1: &BytesN<32>, s2: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    b.append(&Bytes::from(s1.clone()));
    b.append(&Bytes::from(s2.clone()));
    env.crypto().keccak256(&b).into()
}

/// Dice PRNG: keccak256(session_seed ‖ turn_index ‖ player_tag)[0] % 6 + 1.
/// Also computed identically in the Circom circuit (same keccak call).
pub fn roll_value(env: &Env, session_seed: BytesN<32>, turn_index: u32, player_tag: u32) -> u32 {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(session_seed));
    b.append(&Bytes::from_array(env, &turn_index.to_be_bytes()));
    b.append(&Bytes::from_array(env, &player_tag.to_be_bytes()));
    let h: BytesN<32> = env.crypto().keccak256(&b).into();
    (h.get(0).unwrap_or(0) % 6 + 1) as u32
}

/// Position commitment: Poseidon3(x, y, nonce) — matches the Circom circuit.
///
/// Switched from keccak256(x ‖ y ‖ nonce) to Poseidon to enable efficient
/// Groth16 proof generation.
/// `nonce` is treated as a BN254 Fr element (fits since first byte is always 0).
pub fn compute_pos_commit(env: &Env, x: u32, y: u32, nonce: &BytesN<32>) -> BytesN<32> {
    let inputs = vec![
        env,
        u32_to_u256(env, x),
        u32_to_u256(env, y),
        bytes32_to_u256(env, nonce),
    ];
    let h = poseidon_hash::<4, BnScalar>(env, &inputs);
    u256_to_bytes32(env, &h)
}

/// State commitment over all publicly committed on-chain values.
///
/// Kept as keccak256 (not in ZK circuit). The circuit no longer re-derives
/// state commitments; the heist contract verifies them independently.
/// deadline_ts has been removed — per-player chess clocks replace the global deadline.
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
    env.crypto().keccak256(&b).into()
}

/// Computes the single public-input hash for the Groth16 turn validity proof.
///
/// Formula (matches the Circom circuit exactly):
///   h1       = Poseidon4(session_id, turn_index, player_tag, pos_commit_before)
///   h2       = Poseidon5(pos_commit_after, score_delta_fr, loot_delta, no_path_flag, exited_flag)
///   pi_hash  = Poseidon2(h1, h2)
///
/// score_delta uses BN254 Fr representation: negative values → prime + value.
pub fn compute_turn_pi_hash(
    env: &Env,
    session_id: u32,
    turn_index: u32,
    player_tag: u32,
    pos_commit_before: &BytesN<32>,
    pos_commit_after: &BytesN<32>,
    score_delta: i128,
    loot_delta: u32,
    no_path_flag: bool,
    exited_flag: bool,
) -> BytesN<32> {
    // h1 = Poseidon4(session_id, turn_index, player_tag, pos_commit_before)
    let h1 = poseidon_hash::<5, BnScalar>(env, &vec![
        env,
        u32_to_u256(env, session_id),
        u32_to_u256(env, turn_index),
        u32_to_u256(env, player_tag),
        bytes32_to_u256(env, pos_commit_before),
    ]);

    // h2 = Poseidon5(pos_commit_after, score_delta_fr, loot_delta, no_path_flag, exited_flag)
    let h2 = poseidon_hash::<6, BnScalar>(env, &vec![
        env,
        bytes32_to_u256(env, pos_commit_after),
        i128_to_u256(env, score_delta),
        u32_to_u256(env, loot_delta),
        u32_to_u256(env, if no_path_flag { 1 } else { 0 }),
        u32_to_u256(env, if exited_flag { 1 } else { 0 }),
    ]);

    // pi_hash = Poseidon2(h1, h2)
    let pi = poseidon_hash::<3, BnScalar>(env, &vec![env, h1, h2]);
    u256_to_bytes32(env, &pi)
}
