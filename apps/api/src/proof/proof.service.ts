import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

// snarkjs — Groth16 over BN254, matches Soroban Protocol 25 BN254 host functions.
import * as snarkjs from 'snarkjs';

// BN254 scalar field prime (Fr)
const BN254_FR_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ── Input shape ────────────────────────────────────────────────────────────────

export interface ProveInputs {
  // Private: pre-computed map data (player computes locally from shared map seed)
  mapWalls: string;         // hex 18 bytes (144-bit wall bitset)
  mapLoot: string;          // hex 18 bytes (144-bit loot bitset)

  // Private: current position + nonce (Poseidon commitment: Poseidon3(x, y, nonce))
  posX: number;
  posY: number;
  posNonce: string;         // hex 32 bytes — treated as BN254 Fr element (first byte = 0)

  // Private: path (7 slots, padded with end pos for unused steps)
  pathX: number[];
  pathY: number[];
  pathLen: number;

  // Private: new position nonce (client generates fresh random, first byte = 0)
  newPosNonce: string;      // hex 32 bytes — treated as BN254 Fr element

  // Private: exit cell coordinates (derived deterministically from map seed)
  exitX: number;
  exitY: number;

  // Public turn data (all committed via pi_hash inside the circuit)
  sessionId: number;
  turnIndex: number;
  playerTag: number;        // 1 = player1, 2 = player2
  scoreDelta: number;       // net score change (can be negative)
  lootDelta: number;        // loot items collected this turn
  noPathFlag: number;       // 0 or 1
  exitedFlag: number;       // 0 or 1 — player reached the exit cell this turn

  // Derived (computed by engine.ts) — included for logging/validation
  posCommitBefore?: string;  // hex 32 bytes
  posCommitAfter?: string;   // hex 32 bytes
}

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class ProofService {
  private readonly logger = new Logger(ProofService.name);

  // Paths to compiled Groth16 artefacts
  private readonly circuitDir: string;
  private readonly wasmPath: string;
  private readonly zkeyPath: string;

  constructor() {
    // Resolve relative to the monorepo root
    this.circuitDir = path.resolve(
      __dirname,
      '..', '..', '..', '..', 'apps', 'circuits', 'turn_validity_g16', 'build',
    );
    this.wasmPath  = path.join(this.circuitDir, 'turn_validity_js', 'turn_validity.wasm');
    this.zkeyPath  = path.join(this.circuitDir, 'turn_validity_final.zkey');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private hexToBytes(hex: string): number[] {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const out: number[] = [];
    for (let i = 0; i < clean.length; i += 2) {
      out.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return out;
  }

  /** Convert a 32-byte hex nonce to a BN254 Fr field element decimal string. */
  private nonceToField(hexNonce: string): string {
    const n = BigInt('0x' + (hexNonce.startsWith('0x') ? hexNonce.slice(2) : hexNonce));
    if (n >= BN254_FR_PRIME) throw new Error('nonce out of BN254 Fr range');
    return n.toString(10);
  }

  /** Convert a signed integer to a BN254 Fr decimal string (negative → prime + n). */
  private intToField(val: number): string {
    const n = BigInt(val);
    const fr = n < 0n ? BN254_FR_PRIME + n : n;
    return fr.toString(10);
  }

  /**
   * Build the input object for snarkjs.groth16.fullProve().
   * All values must be decimal strings or arrays of decimal strings.
   */
  private buildCircuitInputs(inp: ProveInputs): Record<string, unknown> {
    const walls = this.hexToBytes(inp.mapWalls);
    const loot  = this.hexToBytes(inp.mapLoot);

    const pathX = [...inp.pathX];
    const pathY = [...inp.pathY];
    while (pathX.length < 7) pathX.push(pathX[pathX.length - 1] ?? 0);
    while (pathY.length < 7) pathY.push(pathY[pathY.length - 1] ?? 0);

    return {
      map_walls:     walls.map(String),
      map_loot:      loot.map(String),
      pos_x:         String(inp.posX),
      pos_y:         String(inp.posY),
      pos_nonce:     this.nonceToField(inp.posNonce),
      path_x:        pathX.map(String),
      path_y:        pathY.map(String),
      path_len:      String(inp.pathLen),
      new_pos_nonce: this.nonceToField(inp.newPosNonce),
      exit_x:        String(inp.exitX),
      exit_y:        String(inp.exitY),
      session_id:    String(inp.sessionId),
      turn_index:    String(inp.turnIndex),
      player_tag:    String(inp.playerTag),
      score_delta:   this.intToField(inp.scoreDelta),
      loot_delta:    String(inp.lootDelta),
      no_path_flag:  String(inp.noPathFlag),
      exited_flag:   String(inp.exitedFlag),
    };
  }

  /**
   * Pack the snarkjs Groth16 proof + public signals into the binary format
   * expected by the Soroban zk-verifier contract.
   *
   * Format (292 bytes for 1 public input):
   *   [0..4]    n_pub   = 1 (u32 BE)
   *   [4..36]   pi_hash : 32-byte BE
   *   [36..100] pi_a    : G1 (64 bytes)
   *   [100..228] pi_b   : G2 (128 bytes)
   *   [228..292] pi_c   : G1 (64 bytes)
   */
  private packProofBlob(
    proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] },
    publicSignals: string[],
  ): Buffer {
    const fieldToBE32 = (dec: string): Buffer => {
      const n = BigInt(dec);
      const buf = Buffer.alloc(32);
      let tmp = n;
      for (let i = 31; i >= 0; i--) {
        buf[i] = Number(tmp & 0xffn);
        tmp >>= 8n;
      }
      return buf;
    };

    const encodeG1 = (p: string[]): Buffer =>
      Buffer.concat([fieldToBE32(p[0]!), fieldToBE32(p[1]!)]);

    // Soroban BN254 host (src/crypto/bn254.rs) follows Ethereum EIP-197:
    // Fp2 is serialised as c1_BE || c0_BE (imaginary part first).
    // snarkjs JSON uses [c0, c1], so we must swap: output c1 first, c0 second.
    const encodeG2 = (p: string[][]): Buffer =>
      Buffer.concat([
        fieldToBE32(p[0]![1]!), fieldToBE32(p[0]![0]!),  // x: c1 || c0
        fieldToBE32(p[1]![1]!), fieldToBE32(p[1]![0]!),  // y: c1 || c0
      ]);

    const nPubBuf = Buffer.alloc(4);
    nPubBuf.writeUInt32BE(1, 0);

    return Buffer.concat([
      nPubBuf,                          // 4  bytes — n_pub = 1
      fieldToBE32(publicSignals[0]!),   // 32 bytes — pi_hash
      encodeG1(proof.pi_a),             // 64 bytes — A
      encodeG2(proof.pi_b),             // 128 bytes — B
      encodeG1(proof.pi_c),             // 64 bytes — C
    ]);
  }

  // ── Proof generation ────────────────────────────────────────────────────────

  /**
   * Generate a Groth16 proof using snarkjs.
   * Returns the proof blob as a hex string (for Stellar tx submission).
   *
   * Prerequisites: run `npm run compile && npm run setup` inside
   * apps/circuits/turn_validity_g16/ first to generate .wasm and .zkey.
   *
   * Proof generation time: ~1–5 seconds (vs 60–180s for UltraHonk WASM).
   */
  async generateProof(inputs: ProveInputs): Promise<string> {
    if (!fs.existsSync(this.wasmPath)) {
      throw new BadRequestException(
        `Circuit WASM not found at ${this.wasmPath}. ` +
        `Run "npm run compile" inside apps/circuits/turn_validity_g16/ first.`,
      );
    }
    if (!fs.existsSync(this.zkeyPath)) {
      throw new BadRequestException(
        `Proving key not found at ${this.zkeyPath}. ` +
        `Run "npm run setup" inside apps/circuits/turn_validity_g16/ first.`,
      );
    }

    const circuitInputs = this.buildCircuitInputs(inputs);

    this.logger.log('[proof] Generating Groth16 proof (snarkjs)…');
    const t0 = Date.now();

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      this.wasmPath,
      this.zkeyPath,
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    this.logger.log(`[proof] Groth16 proof generated in ${elapsed}s`);
    this.logger.log(`[proof] pi_hash = ${publicSignals[0]}`);

    const blob = this.packProofBlob(
      proof as { pi_a: string[]; pi_b: string[][]; pi_c: string[] },
      publicSignals,
    );

    this.logger.log(`[proof] Proof blob: ${blob.length} bytes`);
    return blob.toString('hex');
  }

  /** Warm-up: no-op for Groth16 (no SRS init needed). */
  async warmUp(): Promise<void> {
    this.logger.log('[proof] Groth16 mode — no backend warm-up needed.');
  }

  /** Check whether circuit artefacts are available. */
  checkStatus(): { circuitReady: boolean; zkeyReady: boolean; mode: string } {
    return {
      circuitReady: fs.existsSync(this.wasmPath),
      zkeyReady:    fs.existsSync(this.zkeyPath),
      mode:         'groth16-bn254',
    };
  }
}
