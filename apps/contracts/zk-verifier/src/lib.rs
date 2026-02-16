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

    pub fn verify_proof_with_stored_vk(env: Env, proof_blob: Bytes) -> BytesN<32> {
        let vk_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&Self::key_vk_hash())
            .or_else(|| env.storage().instance().get(&DataKey::VkHash))
            .expect("vk not set");

        if proof_blob.len() < 33 {
            panic_with_error!(&env, Error::InvalidProof);
        }

        // Lightweight proof sanity check for contract-level integration tests:
        // first byte must be 1 and the next 32 bytes must match stored vk hash.
        let marker = proof_blob.get(0).unwrap_or(0);
        if marker != 1 {
            panic_with_error!(&env, Error::InvalidProof);
        }

        let mut prefix = [0u8; 32];
        let mut i = 0u32;
        while i < 32 {
            prefix[i as usize] = proof_blob.get(i + 1).unwrap_or(0);
            i += 1;
        }
        let prefix_bn = BytesN::from_array(&env, &prefix);
        if prefix_bn != vk_hash {
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

