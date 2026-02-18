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
import type { Position, Camera, Laser } from "./types";

/* ------------------------------------------------------------------ */
/*  Bitset helpers  (mirrors apps/contracts/heist/src/engine.rs)      */
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

/** Convert an 18-byte bitset into a flat boolean array [CELL_COUNT]. */
export function bitsetToFlat(bits: Uint8Array): boolean[] {
  const flat: boolean[] = new Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i++) {
    flat[i] = bitIsSet(bits, i);
  }
  return flat;
}

/** Convert an 18-byte bitset into a 2D grid[y][x]. */
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
/*  Pathfinding (BFS)                                                  */
/* ------------------------------------------------------------------ */

function isWalkable(walls: Uint8Array, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return false;
  return !bitIsSet(walls, y * MAP_W + x);
}

/**
 * Build an effective wall bitset for client-side pathfinding by combining
 * known walls with unrevealed (fog) cells.
 *
 * Unrevealed cells are treated as walls because:
 *  1. The contract validates paths against actual walls (including those in fog).
 *     Routing through fog risks hitting a real wall → InvalidMoveLength.
 *  2. computeLootDelta only knows about visible loot; routing through fog
 *     could mismatch the contract's loot_collected_mask_delta → InvalidTurnData.
 *
 * @param visibleWalls  The player's visible-walls bitset (from PlayerGameView).
 * @param myFog         The player's fog bitset (bit=1 means REVEALED).
 * @returns             Combined bitset where walls and unrevealed cells are 1.
 */
export function makeEffectiveWalls(
  visibleWalls: Uint8Array,
  myFog: Uint8Array,
): Uint8Array {
  const effective = new Uint8Array(BITSET_BYTES);
  for (let i = 0; i < CELL_COUNT; i++) {
    // Block cell if it is a known wall OR if it is unrevealed (fog)
    if (bitIsSet(visibleWalls, i) || !bitIsSet(myFog, i)) {
      bitSet(effective, i);
    }
  }
  return effective;
}

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Find all positions reachable in 1..=`steps` moves from `start` without
 * stepping on walls.
 *
 * With the partial-move rule the player may stop after any number of steps
 * from 1 to the rolled value, so every cell reachable within that budget is
 * a valid landing target.
 */
export function findReachablePositions(
  walls: Uint8Array,
  start: Position,
  steps: number,
): Position[] {
  const reachable = new Set<string>();
  const visited = new Map<string, number>(); // key → min depth to reach
  visited.set(`${start.x},${start.y}`, 0);

  const queue: { x: number; y: number; depth: number }[] = [
    { x: start.x, y: start.y, depth: 0 },
  ];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    // Every non-start cell in the BFS tree is reachable in cur.depth moves.
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

/**
 * Find the SHORTEST path from `start` to `end` using at most `steps` moves.
 * Returns the path (including start) or null when unreachable.
 *
 * With the partial-move rule the player submits whatever path is found here —
 * the contract now accepts paths of length 2..=rolled+1 (1..=rolled steps).
 */
export function findPath(
  walls: Uint8Array,
  start: Position,
  end: Position,
  steps: number,
): Position[] | null {
  if (start.x === end.x && start.y === end.y) return null;

  // BFS tracks parent pointers for path reconstruction.
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
        // Reconstruct path by following parent pointers.
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

  return null; // Destination unreachable within `steps` moves
}

/**
 * Check whether any path of 1..=`steps` moves exists from `start`.
 *
 * With partial-move rules, use `steps = 1` to test whether the player can
 * make even a single move (determines whether no_path_flag / skip is valid).
 */
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

export function computeCameraHits(
  path: Position[],
  cameras: Camera[],
): number {
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
        if (
          pos.x === laser.x1 &&
          pos.y >= laser.y1 &&
          pos.y <= laser.y2
        ) {
          hits++;
          break;
        }
      } else if (laser.y1 === laser.y2) {
        if (
          pos.y === laser.y1 &&
          pos.x >= laser.x1 &&
          pos.x <= laser.x2
        ) {
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
