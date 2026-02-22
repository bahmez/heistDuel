//! ZK Verifier Contract — Groth16 over BN254
//!
//! Uses Protocol 25 BN254 host functions exclusively (no ark-* crates).
//! WASM size: ~15 KB.
//!
//! ## VK binary format (stored via set_vk)
//! ```
//! [  0.. 64]  alpha_g1  : G1 (32-byte x BE ‖ 32-byte y BE)
//! [ 64..192]  beta_g2   : G2 (x0 ‖ x1 ‖ y0 ‖ y1, each 32-byte BE)
//! [192..320]  gamma_g2  : G2
//! [320..448]  delta_g2  : G2
//! [448..452]  n_ic      : u32 BE  (= n_public + 1)
//! [452..]     IC points : n_ic × G1
//! ```
//!
//! ## Proof blob format (sent by client)
//! ```
//! [ 0..  4]  n_pub    : u32 BE (= 1 for our circuit)
//! [ 4.. 36]  pi_hash  : 32-byte BE field element (public input)
//! [36..100]  pi_a     : G1
//! [100..228] pi_b     : G2
//! [228..292] pi_c     : G1
//! ```
//! Total: 292 bytes for 1 public input.
//! Heist contract reads pi_hash at offset [4..36] — unchanged from UltraHonk layout.

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype,
    crypto::bn254::{Fr, Bn254G1Affine, Bn254G2Affine},
    Address, Bytes, BytesN, Env, Symbol, Vec, symbol_short,
};

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
}

fn key_vk() -> Symbol { symbol_short!("vk") }
fn key_vk_hash() -> Symbol { symbol_short!("vk_hash") }

// ── Byte helpers ──────────────────────────────────────────────────────────────

fn read_u32_be(blob: &Bytes, offset: u32) -> u32 {
    let b0 = blob.get(offset).unwrap_or(0) as u32;
    let b1 = blob.get(offset + 1).unwrap_or(0) as u32;
    let b2 = blob.get(offset + 2).unwrap_or(0) as u32;
    let b3 = blob.get(offset + 3).unwrap_or(0) as u32;
    (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
}

fn read_g1(env: &Env, blob: &Bytes, offset: u32) -> Bn254G1Affine {
    let mut arr = [0u8; 64];
    blob.slice(offset..offset + 64).copy_into_slice(&mut arr);
    Bn254G1Affine::from_array(env, &arr)
}

fn read_g2(env: &Env, blob: &Bytes, offset: u32) -> Bn254G2Affine {
    let mut arr = [0u8; 128];
    blob.slice(offset..offset + 128).copy_into_slice(&mut arr);
    Bn254G2Affine::from_array(env, &arr)
}

fn read_fr(env: &Env, blob: &Bytes, offset: u32) -> Fr {
    let mut arr = [0u8; 32];
    blob.slice(offset..offset + 32).copy_into_slice(&mut arr);
    Fr::from_bytes(BytesN::from_array(env, &arr))
}

// ── Groth16 verification ──────────────────────────────────────────────────────

/// Verifies a Groth16 proof using Protocol 25 BN254 host functions.
///
/// Returns the pi_hash field element (proof_blob[4..36]) if verification passes.
///
/// Verification equation:
///   e(-A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) == 1
/// where:
///   vk_x = IC[0] + Σᵢ (public_inputs[i] · IC[i+1])
fn verify_groth16(env: &Env, vk: &Bytes, proof_blob: &Bytes) -> Option<BytesN<32>> {
    // ── Parse VK ──────────────────────────────────────────────────────────────
    if vk.len() < 452 {
        return None;
    }
    let alpha_g1 = read_g1(env, vk, 0);
    let beta_g2  = read_g2(env, vk, 64);
    let gamma_g2 = read_g2(env, vk, 192);
    let delta_g2 = read_g2(env, vk, 320);
    let n_ic     = read_u32_be(vk, 448) as usize;

    let vk_min_len = 452 + n_ic as u32 * 64;
    if vk.len() < vk_min_len {
        return None;
    }

    // ── Parse proof blob ──────────────────────────────────────────────────────
    // Expected: [4 n_pub][32 pi_hash][64 pi_a][128 pi_b][64 pi_c]
    let n_pub = read_u32_be(proof_blob, 0) as usize;
    if n_pub + 1 != n_ic {
        return None; // public input count mismatch
    }
    let pub_offset: u32 = 4;
    let pi_a_offset = pub_offset + n_pub as u32 * 32;
    let pi_b_offset = pi_a_offset + 64;
    let pi_c_offset = pi_b_offset + 128;

    if proof_blob.len() < pi_c_offset + 64 {
        return None;
    }

    let pi_a = read_g1(env, proof_blob, pi_a_offset);
    let pi_b = read_g2(env, proof_blob, pi_b_offset);
    let pi_c = read_g1(env, proof_blob, pi_c_offset);

    // ── Compute vk_x = IC[0] + pi_hash · IC[1] ───────────────────────────────
    let bn = env.crypto().bn254();

    let ic0 = read_g1(env, vk, 452);
    let mut vk_x = ic0;

    for i in 0..n_pub {
        let ic_i   = read_g1(env, vk, 452 + (i as u32 + 1) * 64);
        let scalar = read_fr(env, proof_blob, pub_offset + i as u32 * 32);
        let term   = bn.g1_mul(&ic_i, &scalar);
        vk_x       = bn.g1_add(&vk_x, &term);
    }

    // ── Pairing check: e(-A,B)·e(α,β)·e(vk_x,γ)·e(C,δ) == 1 ─────────────────
    let neg_pi_a = -pi_a;

    let mut g1s: Vec<Bn254G1Affine> = Vec::new(env);
    g1s.push_back(neg_pi_a);
    g1s.push_back(alpha_g1);
    g1s.push_back(vk_x);
    g1s.push_back(pi_c);

    let mut g2s: Vec<Bn254G2Affine> = Vec::new(env);
    g2s.push_back(pi_b);
    g2s.push_back(beta_g2);
    g2s.push_back(gamma_g2);
    g2s.push_back(delta_g2);

    if !bn.pairing_check(g1s, g2s) {
        return None;
    }

    // Return the public input (pi_hash) as BytesN<32>
    let mut pi_arr = [0u8; 32];
    proof_blob.slice(pub_offset..pub_offset + 32).copy_into_slice(&mut pi_arr);
    Some(BytesN::from_array(env, &pi_arr))
}

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct ZkVerifierContract;

#[contractimpl]
impl ZkVerifierContract {

    // ── Initialisation ─────────────────────────────────────────────────────────

    pub fn __constructor(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    // ── VK management ──────────────────────────────────────────────────────────

    /// Store the Groth16 verification key (binary format) and return its SHA-256 hash.
    /// Admin-only.
    pub fn set_vk(env: Env, vk: Bytes) -> BytesN<32> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();

        env.storage().instance().set(&key_vk(), &vk);

        let hash: BytesN<32> = env.crypto().sha256(&vk).into();
        env.storage().instance().set(&key_vk_hash(), &hash);
        hash
    }

    pub fn get_vk_hash(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&key_vk_hash())
    }

    // ── Proof verification ─────────────────────────────────────────────────────

    /// Verifies a Groth16 proof and returns keccak256(proof_blob) on success.
    ///
    /// The heist contract extracts pi_hash from proof_blob[4..36] and verifies
    /// it matches the expected public data independently.
    pub fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> BytesN<32> {
        let vk: Bytes = env
            .storage()
            .instance()
            .get(&key_vk())
            .expect("vk not set");

        verify_groth16(&env, &vk, &proof_blob)
            .expect("groth16 verification failed");

        let proof_id: BytesN<32> = env.crypto().keccak256(&proof_blob).into();
        env.storage().instance().set(&proof_id, &true);
        proof_id
    }

    pub fn is_verified(env: Env, proof_id: BytesN<32>) -> bool {
        env.storage().instance().get(&proof_id).unwrap_or(false)
    }

    // ── Upgrade ────────────────────────────────────────────────────────────────

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }
}
