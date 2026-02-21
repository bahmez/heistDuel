#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address, Bytes, BytesN, Env,
    Symbol,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    NotAdmin = 2,
    InvalidProof = 3,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Vk,
    VkHash,
    Verified(BytesN<32>),
}

#[contract]
pub struct ZkVerifierContract;

#[contractimpl]
impl ZkVerifierContract {
    fn key_vk() -> Symbol {
        symbol_short!("vk")
    }

    fn key_vk_hash() -> Symbol {
        symbol_short!("vkhash")
    }

    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn set_vk(env: Env, vk_json: Bytes) -> BytesN<32> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin not set");
        admin.require_auth();

        env.storage().instance().set(&Self::key_vk(), &vk_json);
        let vk_hash: BytesN<32> = env.crypto().keccak256(&vk_json).into();
        env.storage().instance().set(&Self::key_vk_hash(), &vk_hash);
        env.storage().instance().set(&DataKey::Vk, &vk_json);
        env.storage().instance().set(&DataKey::VkHash, &vk_hash);
        vk_hash
    }

    /// Verifies a proof blob produced by the Noir turn_validity circuit.
    ///
    /// Expected proof_blob layout (matches UltraHonk / Barretenberg wire format):
    ///   bytes  0..4   — big-endian u32 count of public inputs (must be 1)
    ///   bytes  4..36  — the single public input (pi_hash, 32 bytes)
    ///   bytes 36..    — actual UltraHonk proof bytes
    ///
    /// The heist contract already verifies that pi_hash matches the computed
    /// expected value before calling this function, so the verifier only needs
    /// to check the structural format and (in production) the cryptographic proof.
    ///
    /// This mock implementation performs a structural sanity check only.
    /// In production, replace with the real UltraHonk verifier from
    /// github.com/aztecprotocol/ultrahonk_soroban_contract.
    pub fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> BytesN<32> {
        // VK must be set before any proof is accepted.
        let _vk_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&Self::key_vk_hash())
            .or_else(|| env.storage().instance().get(&DataKey::VkHash))
            .expect("vk not set");

        // Minimum: 4-byte count header + 32-byte pi_hash.
        if proof_blob.len() < 36 {
            panic_with_error!(&env, Error::InvalidProof);
        }

        // Count must be exactly 1 (one public input: pi_hash).
        let count = ((proof_blob.get(0).unwrap_or(0) as u32) << 24)
            | ((proof_blob.get(1).unwrap_or(0) as u32) << 16)
            | ((proof_blob.get(2).unwrap_or(0) as u32) << 8)
            | (proof_blob.get(3).unwrap_or(0) as u32);
        if count != 1 {
            panic_with_error!(&env, Error::InvalidProof);
        }

        let proof_id: BytesN<32> = env.crypto().keccak256(&proof_blob).into();
        env.storage()
            .instance()
            .set(&DataKey::Verified(proof_id.clone()), &true);
        proof_id
    }

    pub fn is_verified(env: Env, proof_id: BytesN<32>) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Verified(proof_id))
            .unwrap_or(false)
    }

    pub fn get_vk_hash(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&Self::key_vk_hash())
    }
}

#[cfg(test)]
mod test;

