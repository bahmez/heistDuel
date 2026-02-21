#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};

use crate::{ZkVerifierContract, ZkVerifierContractClient};

/// Build a valid proof_blob: [count=1 (4 bytes)] [pi_hash (32 bytes)] [dummy proof byte]
fn build_valid_proof(env: &Env, pi_hash: &BytesN<32>) -> Bytes {
    let mut proof = Bytes::new(env);
    // count = 1 as big-endian u32
    proof.push_back(0x00);
    proof.push_back(0x00);
    proof.push_back(0x00);
    proof.push_back(0x01);
    // 32-byte pi_hash (the single public input)
    let mut i = 0u32;
    while i < 32 {
        proof.push_back(pi_hash.get(i).unwrap());
        i += 1;
    }
    // At least one dummy proof byte so it's realistic
    proof.push_back(0x07);
    proof
}

#[test]
fn set_vk_and_verify_roundtrip() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ZkVerifierContract, (admin.clone(),));
    let client = ZkVerifierContractClient::new(&env, &contract_id);

    let vk = Bytes::from_array(&env, b"vk-test");
    let vk_hash = client.set_vk(&vk);

    let pi_hash: BytesN<32> = env.crypto().keccak256(&Bytes::from_array(&env, b"turn-public")).into();
    let proof = build_valid_proof(&env, &pi_hash);
    let proof_id = client.verify_proof_with_stored_vk(&proof);

    assert!(client.is_verified(&proof_id));
    assert_eq!(client.get_vk_hash(), Some(vk_hash));
}

#[test]
#[should_panic]
fn reject_bad_count() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ZkVerifierContract, (admin.clone(),));
    let client = ZkVerifierContractClient::new(&env, &contract_id);

    let vk = Bytes::from_array(&env, b"vk-test");
    client.set_vk(&vk);

    let pi_hash: BytesN<32> = env.crypto().keccak256(&Bytes::from_array(&env, b"turn-public")).into();
    let mut proof = build_valid_proof(&env, &pi_hash);
    // Set count = 2 instead of 1
    proof.set(3, 2u8);

    let _ = client.verify_proof_with_stored_vk(&proof);
}

#[test]
#[should_panic]
fn reject_too_short() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ZkVerifierContract, (admin.clone(),));
    let client = ZkVerifierContractClient::new(&env, &contract_id);

    let vk = Bytes::from_array(&env, b"vk-test");
    client.set_vk(&vk);

    // Only 10 bytes — too short
    let proof = Bytes::from_array(&env, b"tooshort!!");
    let _ = client.verify_proof_with_stored_vk(&proof);
}

#[test]
#[should_panic]
fn reject_without_vk() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ZkVerifierContract, (admin.clone(),));
    let client = ZkVerifierContractClient::new(&env, &contract_id);

    // No set_vk call — should panic with "vk not set"
    let pi_hash: BytesN<32> = env.crypto().keccak256(&Bytes::from_array(&env, b"test")).into();
    let proof = build_valid_proof(&env, &pi_hash);
    let _ = client.verify_proof_with_stored_vk(&proof);
}
