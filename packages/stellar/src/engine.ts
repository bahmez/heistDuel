import sha3 from "js-sha3";
const keccak = sha3.keccak256;
import {
  MAP_W,
  MAP_H,
  CELL_COUNT,
  BITSET_BYTES,
  CAMERA_PENALTY,
  LASER_PENALTY,
} from "./constants";
import type { Position } from "./types";

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

function writeU64BE(out: Uint8Array, offset: number, v: bigint): void {
  let bits = v;
  for (let i = 7; i >= 0; i--) {
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

  // Place walls (up to 18, skipping spawn-adjacent cells)
  let placedWalls = 0;
  for (let i = 0; i < 80 && placedWalls < 18; i++) {
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

  // Place loot (exactly 24 items)
  let placedLoot = 0;
  for (let j = 0; j < 160 && placedLoot < 24; j++) {
    const r = seededU32(mapSeed, 2, j);
    const x = r % MAP_W;
    const y = Math.floor(r / MAP_W) % MAP_H;
    const bit = y * MAP_W + x;
    if (!nearSpawn(x, y) && !bitIsSet(walls, bit) && !bitIsSet(loot, bit)) {
      bitSet(loot, bit);
      placedLoot++;
    }
  }

  // Place cameras (up to 3)
  for (let c = 0; c < 3; c++) {
    const r = seededU32(mapSeed, 3, c);
    const x = r % MAP_W;
    const y = Math.floor(r / MAP_W) % MAP_H;
    if (!nearSpawn(x, y)) {
      cameras.push({ x, y, radius: 2 });
    }
  }

  // Place lasers (up to 2)
  for (let l = 0; l < 2; l++) {
    const r = seededU32(mapSeed, 4, l);
    if ((r & 1) === 0) {
      const y = Math.floor(r / 17) % MAP_H;
      if (y > 1 && y < MAP_H - 2) {
        lasers.push({ x1: 1, y1: y, x2: MAP_W - 2, y2: y });
      }
    } else {
      const x = Math.floor(r / 17) % MAP_W;
      if (x > 1 && x < MAP_W - 2) {
        lasers.push({ x1: x, y1: 1, x2: x, y2: MAP_H - 2 });
      }
    }
  }

  return { walls, loot, cameras, lasers };
}

/**
 * Serialize map data into bytes for commitment computation.
 * Format (big-endian u32 for all integer fields):
 *   walls (18 bytes) || loot (18 bytes)
 *   || num_cameras (1 byte) || cameras[i]: x(4) y(4) radius(4)
 *   || num_lasers  (1 byte) || lasers[i]:  x1(4) y1(4) x2(4) y2(4)
 *
 * Must match the Noir circuit's keccak preimage exactly.
 */
export function serializeMapData(mapData: MapData): Uint8Array {
  const camBytes = 1 + mapData.cameras.length * 12;
  const lasBytes = 1 + mapData.lasers.length * 16;
  const total = 18 + 18 + camBytes + lasBytes;
  const out = new Uint8Array(total);
  let off = 0;

  out.set(mapData.walls, off); off += 18;
  out.set(mapData.loot, off); off += 18;

  out[off++] = mapData.cameras.length;
  for (const cam of mapData.cameras) {
    writeU32BE(out, off, cam.x); off += 4;
    writeU32BE(out, off, cam.y); off += 4;
    writeU32BE(out, off, cam.radius); off += 4;
  }

  out[off++] = mapData.lasers.length;
  for (const laser of mapData.lasers) {
    writeU32BE(out, off, laser.x1); off += 4;
    writeU32BE(out, off, laser.y1); off += 4;
    writeU32BE(out, off, laser.x2); off += 4;
    writeU32BE(out, off, laser.y2); off += 4;
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
 * Position commitment: keccak256(x_BE_u32 ‖ y_BE_u32 ‖ nonce_32bytes).
 * Mirrors compute_pos_commit in engine.rs.
 */
export function computePosCommit(x: number, y: number, nonce: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + 4 + 32);
  writeU32BE(data, 0, x);
  writeU32BE(data, 4, y);
  data.set(nonce, 8);
  return keccak256(data);
}

/**
 * State commitment over all on-chain committed values.
 * Mirrors compute_state_commitment in engine.rs.
 * Must match exactly for the Noir circuit's state_commit_before/after checks.
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
  deadlineTs: bigint,
): Uint8Array {
  const out = new Uint8Array(4 + 4 + 16 + 16 + 32 + 32 + 32 + 32 + 8);
  let off = 0;
  writeU32BE(out, off, sessionId); off += 4;
  writeU32BE(out, off, turnIndex); off += 4;
  writeI128BE(out, off, player1Score); off += 16;
  writeI128BE(out, off, player2Score); off += 16;
  out.set(mapCommitment, off); off += 32;
  out.set(player1PosCommit, off); off += 32;
  out.set(player2PosCommit, off); off += 32;
  out.set(sessionSeed, off); off += 32;
  writeU64BE(out, off, deadlineTs);
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
 * Compute the single ZK public input hash for a turn.
 *
 * The Noir circuit has exactly ONE public input (pi_hash) which is
 * keccak256 of all public turn data, with the first byte zeroed to fit
 * in a BN254 field element (< 2^254).
 *
 * The proof_blob submitted to the contract must have:
 *   bytes [0..4]  = 0x00000001 (count = 1 public input)
 *   bytes [4..36] = pi_hash (32 bytes, first byte = 0x00)
 *   bytes [36..]  = proof bytes
 *
 * Mirrors compute_turn_pi_hash() in engine.rs.
 */
export function computeTurnPiHash(
  sessionId: number,
  turnIndex: number,
  playerTag: number,
  p1MapSeedCommit: Uint8Array,
  p2MapSeedCommit: Uint8Array,
  mapCommitment: Uint8Array,
  posCommitBefore: Uint8Array,
  posCommitAfter: Uint8Array,
  stateCommitBefore: Uint8Array,
  stateCommitAfter: Uint8Array,
  scoreDelta: bigint,
  lootDelta: number,
  noPathFlag: boolean,
): Uint8Array {
  const out = new Uint8Array(4 + 4 + 4 + 32 + 32 + 32 + 32 + 32 + 32 + 32 + 16 + 4 + 1);
  let off = 0;
  writeU32BE(out, off, sessionId); off += 4;
  writeU32BE(out, off, turnIndex); off += 4;
  writeU32BE(out, off, playerTag); off += 4;
  out.set(p1MapSeedCommit, off); off += 32;
  out.set(p2MapSeedCommit, off); off += 32;
  out.set(mapCommitment, off); off += 32;
  out.set(posCommitBefore, off); off += 32;
  out.set(posCommitAfter, off); off += 32;
  out.set(stateCommitBefore, off); off += 32;
  out.set(stateCommitAfter, off); off += 32;
  writeI128BE(out, off, scoreDelta); off += 16;
  writeU32BE(out, off, lootDelta); off += 4;
  out[off] = noPathFlag ? 1 : 0;

  const raw = keccak256(out);
  // Zero first byte to guarantee the value fits in BN254 field (< 2^254).
  raw[0] = 0;
  return raw;
}

/**
 * Wrap a raw Barretenberg proof with the pi_hash public input header.
 *
 * The resulting bytes are what gets submitted as `proof_blob` to submit_turn().
 * Format: [0x00, 0x00, 0x00, 0x01][pi_hash (32 bytes)][raw_proof_bytes]
 */
export function wrapProofBlob(piHash: Uint8Array, rawProof: Uint8Array): Uint8Array {
  const blob = new Uint8Array(4 + 32 + rawProof.length);
  // count = 1 (big-endian u32)
  blob[0] = 0x00;
  blob[1] = 0x00;
  blob[2] = 0x00;
  blob[3] = 0x01;
  blob.set(piHash, 4);
  blob.set(rawProof, 36);
  return blob;
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
    if (bitIsSet(loot, bit) && !bitIsSet(lootCollected, bit)) {
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

export function computeCameraHits(path: Position[], cameras: Camera[]): number {
  let hits = 0;
  for (const cam of cameras) {
    for (const pos of path) {
      const dx = Math.abs(pos.x - cam.x);
      const dy = Math.abs(pos.y - cam.y);
      if (dx + dy <= cam.radius) {
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
