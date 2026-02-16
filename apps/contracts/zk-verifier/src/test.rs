#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};

use crate::{ZkVerifierContract, ZkVerifierContractClient};

fn build_valid_proof(env: &Env, vk_hash: BytesN<32>) -> Bytes {
    let mut proof = Bytes::new(env);
    proof.push_back(1u8);
    let mut i = 0u32;
    while i < 32 {
        proof.push_back(vk_hash.get(i).unwrap());
        i += 1;
    }
    proof.push_back(7u8);
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

    let proof = build_valid_proof(&env, vk_hash.clone());
    let proof_id = client.verify_proof_with_stored_vk(&proof);

    assert!(client.is_verified(&proof_id));
    assert_eq!(client.get_vk_hash(), Some(vk_hash));
}

#[test]
#[should_panic]
fn reject_invalid_proof_prefix() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(ZkVerifierContract, (admin.clone(),));
    let client = ZkVerifierContractClient::new(&env, &contract_id);

    let vk = Bytes::from_array(&env, b"vk-test");
    let vk_hash = client.set_vk(&vk);

    let mut proof = build_valid_proof(&env, vk_hash);
    proof.set(0, 9u8);

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

    let proof = Bytes::from_array(&env, b"short");
    let _ = client.verify_proof_with_stored_vk(&proof);
}
