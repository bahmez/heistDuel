/**
 * Generate a Groth16 proof for a HeistDuel turn.
 *
 * Input: JSON turn data on stdin or as first argument
 * Output: { proofBlob: "0x...", piHash: "0x..." }
 *
 * The proofBlob format matches the Soroban contract:
 *   [4 n_pub=1][32 pi_hash][64 pi_a][128 pi_b][64 pi_c]
 */

import * as snarkjs from "snarkjs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, "../build");
const WASM_FILE = path.join(BUILD_DIR, "turn_validity_js/turn_validity.wasm");
const ZKEY_FILE = path.join(BUILD_DIR, "turn_validity_final.zkey");

/**
 * Generate a Groth16 proof for a HeistDuel turn.
 *
 * @param {object} input - Circuit private+public inputs matching turn_validity.circom
 * @returns {{ proofBlob: Buffer, piHash: Buffer, proof: object, publicSignals: string[] }}
 */
export async function proveGroth16(input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    WASM_FILE,
    ZKEY_FILE,
  );

  const proofBlob = packProofBlob(proof, publicSignals);
  const piHash = Buffer.from(
    BigInt(publicSignals[0]).toString(16).padStart(64, "0"),
    "hex"
  );

  return { proofBlob, piHash, proof, publicSignals };
}

/**
 * Pack proof and public signals into the binary format expected by the
 * Soroban zk-verifier contract.
 *
 * Format:
 *   [0..4]    n_pub   = 1 (u32 BE)
 *   [4..36]   pi_hash = publicSignals[0] as 32-byte BE
 *   [36..100] pi_a    = G1 (64 bytes)
 *   [100..228] pi_b   = G2 (128 bytes)
 *   [228..292] pi_c   = G1 (64 bytes)
 */
function packProofBlob(proof, publicSignals) {
  function fieldToBE32(decStr) {
    const n = BigInt(decStr);
    const buf = Buffer.alloc(32);
    let tmp = n;
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(tmp & 0xffn);
      tmp >>= 8n;
    }
    return buf;
  }

  function encodeG1(point) {
    return Buffer.concat([fieldToBE32(point[0]), fieldToBE32(point[1])]);
  }

  function encodeG2(point) {
    // snarkjs G2: [[x0,x1],[y0,y1],["1","0"]]
    // Soroban format: x0 ‖ x1 ‖ y0 ‖ y1 (each 32 bytes BE)
    return Buffer.concat([
      fieldToBE32(point[0][0]), fieldToBE32(point[0][1]),
      fieldToBE32(point[1][0]), fieldToBE32(point[1][1]),
    ]);
  }

  const n_pub_buf = Buffer.alloc(4);
  n_pub_buf.writeUInt32BE(1, 0);

  return Buffer.concat([
    n_pub_buf,                      // 4  bytes
    fieldToBE32(publicSignals[0]),  // 32 bytes — pi_hash
    encodeG1(proof.pi_a),           // 64 bytes
    encodeG2(proof.pi_b),           // 128 bytes
    encodeG1(proof.pi_c),           // 64 bytes
  ]); // total: 292 bytes
}

// CLI usage: node prove.mjs '<json>'
if (process.argv[2]) {
  const input = JSON.parse(process.argv[2]);
  const result = await proveGroth16(input);
  process.stdout.write(JSON.stringify({
    proofBlob: result.proofBlob.toString("hex"),
    piHash: result.piHash.toString("hex"),
  }));
}
