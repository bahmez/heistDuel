/**
 * Groth16 trusted setup for turn_validity.circom
 *
 * Generates the proving key (zkey) and verification key (vk) locally.
 * For testnet/hackathon use — the toxic waste is known (insecure), which is
 * acceptable for testing. For mainnet: use a multi-party ceremony.
 */

import * as snarkjs from "snarkjs";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR  = path.join(__dirname, "../build");
const PTAU_0     = path.join(BUILD_DIR, "pot14_0000.ptau");
const PTAU_1     = path.join(BUILD_DIR, "pot14_0001.ptau");
const PTAU_FINAL = path.join(BUILD_DIR, "pot14_final.ptau");
const R1CS_FILE  = path.join(BUILD_DIR, "turn_validity.r1cs");
const ZKEY_0     = path.join(BUILD_DIR, "turn_validity_0000.zkey");
const ZKEY_FINAL = path.join(BUILD_DIR, "turn_validity_final.zkey");

mkdirSync(BUILD_DIR, { recursive: true });

async function main() {
  // ── Phase 1: Powers of Tau (local insecure generation) ────────────────────
  console.log("⚙  Phase 1: Generating Powers of Tau (2^14 = 16384 max constraints)...");
  console.log("   (This takes ~1–2 minutes)");
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  await snarkjs.powersOfTau.newAccumulator(curve, 14, PTAU_0);

  console.log("⚙  Adding randomness contribution...");
  await snarkjs.powersOfTau.contribute(
    PTAU_0,
    PTAU_1,
    "HeistDuel Testnet 2026",
    "heistduel-hackathon-random-entropy-testnet-only",
  );

  console.log("⚙  Preparing Phase 2 beacon...");
  await snarkjs.powersOfTau.preparePhase2(PTAU_1, PTAU_FINAL);
  console.log("✓  pot14_final.ptau ready");

  // ── Phase 2: Circuit-specific setup ───────────────────────────────────────
  console.log("\n⚙  Phase 2: Groth16 circuit setup...");
  await snarkjs.zKey.newZKey(R1CS_FILE, PTAU_FINAL, ZKEY_0);

  console.log("⚙  Adding phase 2 contribution...");
  await snarkjs.zKey.contribute(
    ZKEY_0,
    ZKEY_FINAL,
    "HeistDuel Circuit Testnet",
    "circuit-contribution-testnet-entropy",
  );
  console.log("✓  turn_validity_final.zkey ready");

  // ── Export VK as JSON ──────────────────────────────────────────────────────
  console.log("\n⚙  Exporting verification key...");
  const vkJson = await snarkjs.zKey.exportVerificationKey(ZKEY_FINAL);
  const vkJsonPath = path.join(BUILD_DIR, "vk.json");
  writeFileSync(vkJsonPath, JSON.stringify(vkJson, null, 2));
  console.log("✓  vk.json exported");

  // ── Export VK as binary for Soroban contract ───────────────────────────────
  const vkBin = exportVkBinary(vkJson);
  const vkBinPath = path.join(BUILD_DIR, "vk.bin");
  writeFileSync(vkBinPath, vkBin);
  console.log(`✓  vk.bin exported (${vkBin.length} bytes, Soroban format)`);

  console.log("\n✅ Setup complete!");
  console.log(`   Proving key:  ${ZKEY_FINAL}`);
  console.log(`   VK JSON:      ${vkJsonPath}`);
  console.log(`   VK binary:    ${vkBinPath}`);
}

/**
 * Export VK as a binary blob matching the Soroban zk-verifier format:
 *   [0..64]   alpha_g1 : G1 (32-byte x BE ‖ 32-byte y BE)
 *   [64..192] beta_g2  : G2 (x0 ‖ x1 ‖ y0 ‖ y1, each 32-byte BE)
 *   [192..320] gamma_g2: G2
 *   [320..448] delta_g2: G2
 *   [448..452] n_ic    : u32 BE (= n_public + 1)
 *   [452..]   IC points: n_ic × G1 (each 64 bytes)
 */
function exportVkBinary(vk) {
  function fieldToBE32(decStr) {
    const n = BigInt(decStr);
    const buf = Buffer.alloc(32);
    let tmp = n;
    for (let i = 31; i >= 0; i--) { buf[i] = Number(tmp & 0xffn); tmp >>= 8n; }
    return buf;
  }
  function encodeG1(p) {
    return Buffer.concat([fieldToBE32(p[0]), fieldToBE32(p[1])]);
  }
  function encodeG2(p) {
    // snarkjs G2 JSON: [[c0,c1],[c0,c1],["1","0"]]  (c0 = real, c1 = imaginary)
    // Soroban BN254 host uses Ethereum EIP-197 Fp2 encoding: c1_BE || c0_BE
    // (imaginary part first). The host reverses the 64-byte Fp2 buffer before
    // passing to arkworks (which uses c0_LE || c1_LE internally).
    // Therefore we must output c1 first, then c0.
    return Buffer.concat([
      fieldToBE32(p[0][1]), fieldToBE32(p[0][0]),  // x: c1 || c0
      fieldToBE32(p[1][1]), fieldToBE32(p[1][0]),  // y: c1 || c0
    ]);
  }

  const n_ic_buf = Buffer.alloc(4);
  n_ic_buf.writeUInt32BE(vk.IC.length, 0);

  return Buffer.concat([
    encodeG1(vk.vk_alpha_1),           // 64 bytes
    encodeG2(vk.vk_beta_2),            // 128 bytes
    encodeG2(vk.vk_gamma_2),           // 128 bytes
    encodeG2(vk.vk_delta_2),           // 128 bytes
    n_ic_buf,                          // 4 bytes
    ...vk.IC.map(encodeG1),            // n_ic × 64 bytes
  ]);
}

main().catch(err => { console.error(err); process.exit(1); });
