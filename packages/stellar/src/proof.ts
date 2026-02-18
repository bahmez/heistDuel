/**
 * Mock proof construction for testnet.
 *
 * The ZK verifier on testnet expects: [0x01, vk_hash(32), public_inputs_hash(32)]
 * Total 65 bytes minimum.
 */
export function buildMockProof(
  vkHash: Uint8Array,
  publicInputsHash: Uint8Array,
): Uint8Array {
  if (vkHash.length !== 32) throw new Error("vkHash must be 32 bytes");
  if (publicInputsHash.length !== 32)
    throw new Error("publicInputsHash must be 32 bytes");

  const proof = new Uint8Array(65);
  proof[0] = 1;
  proof.set(vkHash, 1);
  proof.set(publicInputsHash, 33);
  return proof;
}
