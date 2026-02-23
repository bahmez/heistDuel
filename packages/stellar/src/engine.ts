import sha3 from "js-sha3";
const keccak = sha3.keccak256;
import { poseidon2, poseidon3, poseidon4, poseidon5 } from "poseidon-lite";
import {
  MAP_W,
  MAP_H,
  CELL_COUNT,
  BITSET_BYTES,
  CAMERA_PENALTY,
  LASER_PENALTY,
} from "./constants";
import type { Position } from "./types";

// BN254 scalar field prime
const BN254_FR_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Convert a BigInt field element to a 32-byte big-endian Uint8Array. */
function fieldToBytes32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let tmp = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }
  return out;
}

/** Convert a 32-byte big-endian Uint8Array to a BigInt field element. */
function bytes32ToField(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < 32; i++) {
    n = (n << 8n) | BigInt(b[i]!);
  }
  return n;
}

/** Represent a signed integer as a BN254 Fr element (negative → prime + value). */
function intToField(val: bigint): bigint {
  return val < 0n ? BN254_FR_PRIME + val : val;
}

export interface Camera {
  x: number;
  y: number;
  radius: number;
}

export interface Laser {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MapData {
  walls: Uint8Array;    // 18-byte bitset
  loot: Uint8Array;     // 18-byte bitset
  cameras: Camera[];
  lasers: Laser[];
  /** Exit cell (deterministic from map seed, away from spawns and walls). */
  exitCell: { x: number; y: number };
}

/* ------------------------------------------------------------------ */
/*  Bitset helpers (mirrors apps/contracts/heist/src/engine.rs)       */
/* ------------------------------------------------------------------ */

export function bitIsSet(bits: Uint8Array, index: number): boolean {
  const byte = Math.floor(index / 8);
  const offset = index % 8;
  return (bits[byte]! & (1 << offset)) !== 0;
}

export function bitSet(bits: Uint8Array, index: number): void {
  const byte = Math.floor(index / 8);
  const offset = index % 8;
  bits[byte]! |= 1 << offset;
}

export function hasAnySetBit(bits: Uint8Array): boolean {
  for (let i = 0; i < BITSET_BYTES; i++) {
    if (bits[i] !== 0) return true;
  }
  return false;
}

export function zeroBitset(): Uint8Array {
  return new Uint8Array(BITSET_BYTES);
}

/* ------------------------------------------------------------------ */
/*  Grid conversion                                                    */
/* ------------------------------------------------------------------ */

export function bitsetToFlat(bits: Uint8Array): boolean[] {
  const flat: boolean[] = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    flat[i] = bitIsSet(bits, i);
  }
  return flat;
}

export function bitsetToGrid(bits: Uint8Array): boolean[][] {
  const grid: boolean[][] = [];
  for (let y = 0; y < MAP_H; y++) {
    grid[y] = [];
    for (let x = 0; x < MAP_W; x++) {
      grid[y]![x] = bitIsSet(bits, y * MAP_W + x);
    }
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/*  Keccak-256                                                         */
/* ------------------------------------------------------------------ */

export function keccak256(data: Uint8Array): Uint8Array {
  return new Uint8Array(keccak.arrayBuffer(data));
}

/* ------------------------------------------------------------------ */
/*  Little helpers for byte serialization                             */
/* ------------------------------------------------------------------ */

function writeU32BE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = (v >>> 24) & 0xff;
  out[offset + 1] = (v >>> 16) & 0xff;
  out[offset + 2] = (v >>> 8) & 0xff;
  out[offset + 3] = v & 0xff;
}

/** Write a signed i128 as 16 bytes big-endian (two's complement). */
function writeI128BE(out: Uint8Array, offset: number, v: bigint): void {
  let bits = v < 0n ? v + (1n << 128n) : v;
  for (let i = 15; i >= 0; i--) {
    out[offset + i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
}

/* ------------------------------------------------------------------ */
/*  Seed commit / reveal                                               */
/* ------------------------------------------------------------------ */

export function commitHash(seedSecret: Uint8Array): Uint8Array {
  return keccak256(seedSecret);
}

export function generateRandomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/**
 * Derive the initial private position nonce from the shared map seed.
 * initial_pos_nonce_pN = keccak256(map_seed || player_tag_byte), first byte zeroed.
 *
 * Since both players know the map seed (after the relay), they can each
 * compute BOTH players' initial pos nonces and therefore their initial
 * pos_commits. This allows begin_match to be called by a single party
 * with correct values for both players.
 *
 * The nonce is used as a BN254 Fr element in Poseidon, so we zero the first
 * byte to ensure it fits in the field (< 2^248 < Fr.prime).
 *
 * Privacy is maintained for SUBSEQUENT turns because each player generates
 * a fresh random nonce after the first move (via generatePosNonce()).
 */
export function deriveInitialPosNonce(
  mapSeed: Uint8Array,
  playerTag: 1 | 2,
): Uint8Array {
  const data = new Uint8Array(33);
  data.set(mapSeed, 0);
  data[32] = playerTag;
  const h = keccak256(data);
  h[0] = 0; // ensure fits in BN254 Fr field
  return h;
}

/**
 * Compute the session seed from the session ID and both players' dice seed secrets.
 * session_seed = keccak256(session_id_BE_u32 || player1_seed_bytes || player2_seed_bytes)
 * Mirrors derive_session_seed() in engine.rs exactly (session_id is prepended).
 */
export function computeSessionSeed(
  sessionId: number,
  player1SeedSecret: Uint8Array,
  player2SeedSecret: Uint8Array,
): Uint8Array {
  const data = new Uint8Array(4 + 32 + 32);
  writeU32BE(data, 0, sessionId);
  data.set(player1SeedSecret, 4);
  data.set(player2SeedSecret, 36);
  return keccak256(data);
}

/* ------------------------------------------------------------------ */
/*  ZK Map Secret Relay helpers                                        */
/* ------------------------------------------------------------------ */

/**
 * Derive the shared map seed from two player secrets.
 * map_seed = keccak256(secret1 XOR secret2)
 * Mirrors the Noir circuit's derivation.
 */
export function deriveMapSeed(secret1: Uint8Array, secret2: Uint8Array): Uint8Array {
  const xored = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    xored[i] = (secret1[i] ?? 0) ^ (secret2[i] ?? 0);
  }
  return keccak256(xored);
}

/* ------------------------------------------------------------------ */
/*  Map generation (mirrors generate_map in engine.rs git history)    */
/* ------------------------------------------------------------------ */

/** Deterministic u32 derived from seed + tag + index via keccak256. */
function seededU32(seed: Uint8Array, tag: number, i: number): number {
  const data = new Uint8Array(40);
  data.set(seed, 0);
  writeU32BE(data, 32, tag);
  writeU32BE(data, 36, i);
  const h = keccak256(data);
  return (
    (((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0)
  );
}

function nearSpawn(x: number, y: number): boolean {
  const p1x = 1, p1y = 1, p2x = MAP_W - 2, p2y = MAP_H - 2;
  return (
    (Math.abs(x - p1x) <= 1 && Math.abs(y - p1y) <= 1) ||
    (Math.abs(x - p2x) <= 1 && Math.abs(y - p2y) <= 1)
  );
}

/**
 * Generate the game map from a 32-byte map seed.
 *
 * Faithfully mirrors the Rust generate_map() algorithm so that the same
 * seed always produces the same map on-chain and off-chain.
 * The Noir circuit also replicates this exact algorithm.
 */
export function generateMap(mapSeed: Uint8Array): MapData {
  const walls = new Uint8Array(BITSET_BYTES);
  const loot = new Uint8Array(BITSET_BYTES);
  const cameras: Camera[] = [];
  const lasers: Laser[] = [];

  // Place walls (up to 18, skipping spawn-adjacent cells).
  // 40 iterations matches the Noir circuit — enough to reliably fill 18 slots.
  let placedWalls = 0;
  for (let i = 0; i < 40 && placedWalls < 18; i++) {
    const r = seededU32(mapSeed, 1, i);
    const x = r % MAP_W;
    const y = Math.floor(r / MAP_W) % MAP_H;
    if (!nearSpawn(x, y)) {
      const bit = y * MAP_W + x;
      if (!bitIsSet(walls, bit)) {
        bitSet(walls, bit);
        placedWalls++;
      }
    }
  }

  // Place loot (exactly 24 items).
  // 72 iterations matches the Noir circuit — enough to fill 24 loot slots.
  let placedLoot = 0;
  for (let j = 0; j < 72 && placedLoot < 24; j++) {
    const r = seededU32(mapSeed, 2, j);
    const x = r % MAP_W;
    const y = Math.floor(r / MAP_W) % MAP_H;
    const bit = y * MAP_W + x;
    // bit < 127: keep loot_mask representable as a non-negative i128 on-chain.
    if (!nearSpawn(x, y) && !bitIsSet(walls, bit) && !bitIsSet(loot, bit) && bit < 127) {
      bitSet(loot, bit);
      placedLoot++;
    }
  }

  // Place cameras (up to 3).
  // radius: 1 → detects only center + 4 cardinal neighbours (cross of 5 cells).
  for (let c = 0; c < 3; c++) {
    const r = seededU32(mapSeed, 3, c);
    const x = r % MAP_W;
    const y = Math.floor(r / MAP_W) % MAP_H;
    if (!nearSpawn(x, y)) {
      cameras.push({ x, y, radius: 1 });
    }
  }

  // Place lasers (up to 2).
  // Lasers are at most MAX_LASER_LEN cells long.  High 16 bits of the seed
  // determine the start position so that each game gets a different segment.
  const MAX_LASER_LEN = 5;
  for (let l = 0; l < 2; l++) {
    const r = seededU32(mapSeed, 4, l);
    if ((r & 1) === 0) {
      // Horizontal laser — row chosen from low bits, start-x from high bits.
      const y = Math.floor(r / 17) % MAP_H;
      if (y > 1 && y < MAP_H - 2) {
        const maxStart = MAP_W - 1 - MAX_LASER_LEN;          // inclusive upper bound for x1
        const startX = 1 + ((r >>> 16) % maxStart);
        const x1 = startX;
        const x2 = Math.min(x1 + MAX_LASER_LEN - 1, MAP_W - 2);
        lasers.push({ x1, y1: y, x2, y2: y });
      }
    } else {
      // Vertical laser — column chosen from low bits, start-y from high bits.
      const x = Math.floor(r / 17) % MAP_W;
      if (x > 1 && x < MAP_W - 2) {
        const maxStart = MAP_H - 1 - MAX_LASER_LEN;
        const startY = 1 + ((r >>> 16) % maxStart);
        const y1 = startY;
        const y2 = Math.min(y1 + MAX_LASER_LEN - 1, MAP_H - 2);
        lasers.push({ x1: x, y1, x2: x, y2 });
      }
    }
  }

  // Place exit cell (tag 5) — deterministic, not on a wall, not near spawns.
  let exitX = 0;
  let exitY = 0;
  for (let attempt = 0; attempt < 144; attempt++) {
    const r = seededU32(mapSeed, 5, attempt);
    const x = r % MAP_W;
    const y = Math.floor(r / MAP_W) % MAP_H;
    if (!nearSpawn(x, y) && !bitIsSet(walls, y * MAP_W + x)) {
      exitX = x;
      exitY = y;
      break;
    }
  }
  const exitCell = { x: exitX, y: exitY };

  return { walls, loot, cameras, lasers, exitCell };
}

/**
 * Serialize map data into bytes for commitment computation.
 *
 * IMPORTANT: the layout is FIXED at 106 bytes to match the Noir circuit exactly:
 *   walls(18) || loot(18) || num_cameras(1) || 3×camera(12) || num_lasers(1) || 2×laser(16)
 *   = 18 + 18 + 1 + 36 + 1 + 32 = 106 bytes
 *
 * The circuit always writes all 3 camera slots and both laser slots,
 * using zeroes for unused slots. We must do the same or the keccak hashes diverge.
 */
export function serializeMapData(mapData: MapData): Uint8Array {
  // Fixed 106-byte buffer, all zeroes by default (matches circuit's zero-padding).
  const out = new Uint8Array(106);
  let off = 0;

  out.set(mapData.walls, off); off += 18;
  out.set(mapData.loot, off); off += 18;

  // num_cameras (1 byte), then always 3 slots of 12 bytes each.
  out[off++] = mapData.cameras.length;
  for (let i = 0; i < 3; i++) {
    const cam = mapData.cameras[i];
    writeU32BE(out, off, cam ? cam.x : 0); off += 4;
    writeU32BE(out, off, cam ? cam.y : 0); off += 4;
    writeU32BE(out, off, cam ? cam.radius : 0); off += 4;
  }

  // num_lasers (1 byte), then always 2 slots of 16 bytes each.
  out[off++] = mapData.lasers.length;
  for (let i = 0; i < 2; i++) {
    const laser = mapData.lasers[i];
    writeU32BE(out, off, laser ? laser.x1 : 0); off += 4;
    writeU32BE(out, off, laser ? laser.y1 : 0); off += 4;
    writeU32BE(out, off, laser ? laser.x2 : 0); off += 4;
    writeU32BE(out, off, laser ? laser.y2 : 0); off += 4;
  }

  return out;
}

/**
 * Compute the on-chain map commitment: keccak256(serialize(mapData)).
 * This value is what both players submit to begin_match().
 */
export function computeMapCommitment(mapData: MapData): Uint8Array {
  return keccak256(serializeMapData(mapData));
}

/* ------------------------------------------------------------------ */
/*  Position and state commitments                                     */
/* ------------------------------------------------------------------ */

/**
 * Position commitment: Poseidon3(x, y, nonce_fr).
 * Mirrors compute_pos_commit() in engine.rs and the Circom circuit.
 *
 * `nonce` is a 32-byte Uint8Array treated as a BN254 Fr field element
 * (first byte must be 0 to ensure value < Fr.prime).
 */
export function computePosCommit(x: number, y: number, nonce: Uint8Array): Uint8Array {
  const nonce_fr = bytes32ToField(nonce);
  const h = poseidon3([BigInt(x), BigInt(y), nonce_fr]);
  return fieldToBytes32(h);
}

/**
 * Generate a fresh position nonce for Groth16 Poseidon-based commitments.
 *
 * In the Groth16 circuit, the new_pos_nonce is NOT constrained by the circuit
 * (unlike the Noir circuit which enforced keccak derivation).
 * The client is free to choose any valid BN254 Fr element as the new nonce.
 *
 * We generate a random 32-byte value with the first byte zeroed to ensure it
 * fits within the BN254 scalar field prime (< 2^248 ≪ Fr.prime).
 */
export function generatePosNonce(): Uint8Array {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  nonce[0] = 0; // ensure value < 2^248 < Fr.prime
  return nonce;
}

/**
 * @deprecated Use generatePosNonce() instead.
 * Kept for compatibility with existing game state — nonces are now random.
 */
export function deriveNewPosNonce(_posNonce: Uint8Array, _turnIndex: number): Uint8Array {
  return generatePosNonce();
}

/**
 * State commitment over all on-chain committed values.
 * Mirrors compute_state_commitment in engine.rs.
 * Per-player chess clocks replace the global deadline — no deadlineTs included.
 */
export function computeStateCommitment(
  sessionId: number,
  turnIndex: number,
  player1Score: bigint,
  player2Score: bigint,
  mapCommitment: Uint8Array,
  player1PosCommit: Uint8Array,
  player2PosCommit: Uint8Array,
  sessionSeed: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(4 + 4 + 16 + 16 + 32 + 32 + 32 + 32);
  let off = 0;
  writeU32BE(out, off, sessionId); off += 4;
  writeU32BE(out, off, turnIndex); off += 4;
  writeI128BE(out, off, player1Score); off += 16;
  writeI128BE(out, off, player2Score); off += 16;
  out.set(mapCommitment, off); off += 32;
  out.set(player1PosCommit, off); off += 32;
  out.set(player2PosCommit, off); off += 32;
  out.set(sessionSeed, off);
  return keccak256(out);
}

/* ------------------------------------------------------------------ */
/*  Dice PRNG (ZK-compatible keccak version)                          */
/* ------------------------------------------------------------------ */

/**
 * Deterministic dice roll: keccak256(session_seed ‖ turn_index ‖ player_tag)[0] % 6 + 1
 * Mirrors roll_value() in engine.rs (new keccak version).
 */
export function rollValue(
  sessionSeed: Uint8Array,
  turnIndex: number,
  playerTag: number,
): number {
  const data = new Uint8Array(32 + 4 + 4);
  data.set(sessionSeed, 0);
  writeU32BE(data, 32, turnIndex);
  writeU32BE(data, 36, playerTag);
  const h = keccak256(data);
  return (h[0]! % 6) + 1;
}

/* ------------------------------------------------------------------ */
/*  Turn public-input hash                                             */
/* ------------------------------------------------------------------ */

/**
 * Compute the single Groth16 ZK public input hash for a turn.
 *
 * Formula (mirrors compute_turn_pi_hash() in engine.rs and the Circom circuit):
 *   h1      = Poseidon4(session_id, turn_index, player_tag, pos_commit_before_fr)
 *   h2      = Poseidon5(pos_commit_after_fr, score_delta_fr, loot_delta, no_path_flag, exited_flag)
 *   pi_hash = Poseidon2(h1, h2)
 *
 * score_delta: negative values → BN254 Fr representation (prime + value).
 * pos_commit values are treated as Fr field elements (first byte = 0).
 */
export function computeTurnPiHash(
  sessionId: number,
  turnIndex: number,
  playerTag: number,
  posCommitBefore: Uint8Array,
  posCommitAfter: Uint8Array,
  scoreDelta: bigint,
  lootDelta: number,
  noPathFlag: boolean,
  exitedFlag: boolean,
): Uint8Array {
  const pcb = bytes32ToField(posCommitBefore);
  const pca = bytes32ToField(posCommitAfter);
  const sd  = intToField(scoreDelta);

  const h1 = poseidon4([BigInt(sessionId), BigInt(turnIndex), BigInt(playerTag), pcb]);
  const h2 = poseidon5([pca, sd, BigInt(lootDelta), BigInt(noPathFlag ? 1 : 0), BigInt(exitedFlag ? 1 : 0)]);
  const pi = poseidon2([h1, h2]);
  return fieldToBytes32(pi);
}

/* ------------------------------------------------------------------ */
/*  Pathfinding (BFS)                                                  */
/* ------------------------------------------------------------------ */

function isWalkable(walls: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  return !bitIsSet(walls, y * MAP_W + x);
}

/**
 * Build an effective wall bitset combining known walls with unrevealed fog cells.
 * In the ZK model, the client has the full map (generated from map_seed),
 * so fog-masking is optional — pass myFog as all-1s to see the full map.
 */
export function makeEffectiveWalls(
  walls: Uint8Array,
  myFog?: Uint8Array,
): Uint8Array {
  if (!myFog) return walls;
  const effective = new Uint8Array(BITSET_BYTES);
  for (let i = 0; i < CELL_COUNT; i++) {
    if (bitIsSet(walls, i) || !bitIsSet(myFog, i)) {
      bitSet(effective, i);
    }
  }
  return effective;
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function findReachablePositions(
  walls: Uint8Array,
  start: Position,
  steps: number,
): Position[] {
  const reachable = new Set<string>();
  const visited = new Map<string, number>();
  visited.set(`${start.x},${start.y}`, 0);

  const queue: { x: number; y: number; depth: number }[] = [
    { x: start.x, y: start.y, depth: 0 },
  ];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth > 0) {
      reachable.add(`${cur.x},${cur.y}`);
    }
    if (cur.depth >= steps) continue;

    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(walls, nx, ny)) continue;
      const key = `${nx},${ny}`;
      const prev = visited.get(key);
      if (prev !== undefined && prev <= cur.depth + 1) continue;
      visited.set(key, cur.depth + 1);
      queue.push({ x: nx, y: ny, depth: cur.depth + 1 });
    }
  }

  return Array.from(reachable).map((s) => {
    const [x, y] = s.split(",").map(Number);
    return { x: x!, y: y! };
  });
}

export function findPath(
  walls: Uint8Array,
  start: Position,
  end: Position,
  steps: number,
): Position[] | null {
  if (start.x === end.x && start.y === end.y) return null;

  type Node = { x: number; y: number; parent: Node | null };
  const startNode: Node = { x: start.x, y: start.y, parent: null };
  const queue: { node: Node; depth: number }[] = [
    { node: startNode, depth: 0 },
  ];
  const visited = new Set<string>();
  visited.add(`${start.x},${start.y}`);

  while (queue.length > 0) {
    const { node: cur, depth } = queue.shift()!;
    if (depth >= steps) continue;

    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(walls, nx, ny)) continue;
      const key = `${nx},${ny}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const next: Node = { x: nx, y: ny, parent: cur };

      if (nx === end.x && ny === end.y) {
        const path: Position[] = [];
        let n: Node | null = next;
        while (n !== null) {
          path.unshift({ x: n.x, y: n.y });
          n = n.parent;
        }
        return path;
      }

      queue.push({ node: next, depth: depth + 1 });
    }
  }

  return null;
}

export function existsAnyPathLen(
  walls: Uint8Array,
  start: Position,
  steps: number,
): boolean {
  return findReachablePositions(walls, start, steps).length > 0;
}

/* ------------------------------------------------------------------ */
/*  Loot / Hazard computation                                          */
/* ------------------------------------------------------------------ */

export function computeLootDelta(
  loot: Uint8Array,
  lootCollected: Uint8Array,
  path: Position[],
): Uint8Array {
  const delta = zeroBitset();
  for (const pos of path) {
    const bit = pos.y * MAP_W + pos.x;
    // bit < 127: loot_mask is stored as a non-negative i128 on-chain (bit 127 = sign bit).
    if (bit < 127 && bitIsSet(loot, bit) && !bitIsSet(lootCollected, bit)) {
      bitSet(delta, bit);
    }
  }
  return delta;
}

export function countLootInDelta(delta: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < CELL_COUNT; i++) {
    if (bitIsSet(delta, i)) count++;
  }
  return count;
}

/**
 * Camera detection is cross-shaped (+): triggers when the player is in the
 * same row OR same column as the camera, within its radius.
 * Mirrors the updated game rules (cameras detect along axes, not radial area).
 */
export function computeCameraHits(path: Position[], cameras: Camera[]): number {
  let hits = 0;
  for (const cam of cameras) {
    for (const pos of path) {
      const dx = Math.abs(pos.x - cam.x);
      const dy = Math.abs(pos.y - cam.y);
      if ((dx === 0 && dy <= cam.radius) || (dy === 0 && dx <= cam.radius)) {
        hits++;
        break;
      }
    }
  }
  return hits;
}

export function computeLaserHits(path: Position[], lasers: Laser[]): number {
  let hits = 0;
  for (const laser of lasers) {
    for (const pos of path) {
      if (laser.x1 === laser.x2) {
        if (pos.x === laser.x1 && pos.y >= laser.y1 && pos.y <= laser.y2) {
          hits++;
          break;
        }
      } else if (laser.y1 === laser.y2) {
        if (pos.y === laser.y1 && pos.x >= laser.x1 && pos.x <= laser.x2) {
          hits++;
          break;
        }
      }
    }
  }
  return hits;
}

export function computeScoreDelta(
  lootPoints: number,
  cameraHits: number,
  laserHits: number,
): bigint {
  return (
    BigInt(lootPoints) -
    BigInt(cameraHits) * CAMERA_PENALTY -
    BigInt(laserHits) * LASER_PENALTY
  );
}
