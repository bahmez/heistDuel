import {
  bitIsSet,
  findReachablePositions,
  findPath,
  makeEffectiveWalls,
  MAP_W,
  MAP_H,
  type Position,
  type PlayerGameView,
} from "@repo/stellar";

export interface CellState {
  x: number;
  y: number;
  revealed: boolean;
  wall: boolean;
  loot: boolean;
  lootCollected: boolean;
  camera: boolean;
  cameraRadius: number;
  laser: boolean;
  hasPlayer1: boolean;
  hasPlayer2: boolean;
}

/**
 * Convert a PlayerGameView into a 2D grid of CellStates for rendering.
 */
export function buildGrid(view: PlayerGameView): CellState[][] {
  const grid: CellState[][] = [];

  for (let y = 0; y < MAP_H; y++) {
    grid[y] = [];
    for (let x = 0; x < MAP_W; x++) {
      const idx = y * MAP_W + x;
      const revealed = bitIsSet(view.myFog, idx);
      const wall = revealed && bitIsSet(view.visibleWalls, idx);
      const loot = revealed && bitIsSet(view.visibleLoot, idx);
      const lootCollected = bitIsSet(view.lootCollected, idx);

      grid[y]![x] = {
        x,
        y,
        revealed,
        wall,
        loot: loot && !lootCollected,
        lootCollected: loot && lootCollected,
        camera: false,
        cameraRadius: 0,
        laser: false,
        hasPlayer1: view.player1Pos.x === x && view.player1Pos.y === y,
        hasPlayer2: view.player2Pos.x === x && view.player2Pos.y === y,
      };
    }
  }

  for (const cam of view.visibleCameras) {
    if (cam.y < MAP_H && cam.x < MAP_W && grid[cam.y]?.[cam.x]) {
      grid[cam.y]![cam.x]!.camera = true;
      grid[cam.y]![cam.x]!.cameraRadius = cam.radius;
    }
  }

  for (const laser of view.visibleLasers) {
    if (laser.x1 === laser.x2) {
      for (let y = laser.y1; y <= laser.y2; y++) {
        if (y < MAP_H && grid[y]?.[laser.x1]) {
          grid[y]![laser.x1]!.laser = true;
        }
      }
    } else if (laser.y1 === laser.y2) {
      for (let x = laser.x1; x <= laser.x2; x++) {
        if (laser.y1 < MAP_H && grid[laser.y1]?.[x]) {
          grid[laser.y1]![x]!.laser = true;
        }
      }
    }
  }

  return grid;
}

/**
 * Get all cells reachable in exactly `steps` moves.
 * Only considers already-revealed cells as walkable — fog cells are treated
 * as walls to prevent routing through unknown terrain that may contain walls
 * the contract would reject (InvalidMoveLength / InvalidTurnData).
 */
export function getReachableCells(
  view: PlayerGameView,
  playerAddress: string,
  steps: number,
): Position[] {
  const isP1 = playerAddress === view.player1;
  const startPos = isP1 ? view.player1Pos : view.player2Pos;
  const effectiveWalls = makeEffectiveWalls(view.visibleWalls, view.myFog);
  return findReachablePositions(effectiveWalls, startPos, steps);
}

/**
 * Find a path to a destination using only revealed cells.
 * Fog cells are treated as walls — routing through unrevealed territory is
 * unsafe because the contract validates paths against actual (full) walls.
 */
export function findPathTo(
  view: PlayerGameView,
  playerAddress: string,
  destination: Position,
  steps: number,
): Position[] | null {
  const isP1 = playerAddress === view.player1;
  const startPos = isP1 ? view.player1Pos : view.player2Pos;
  const effectiveWalls = makeEffectiveWalls(view.visibleWalls, view.myFog);
  return findPath(effectiveWalls, startPos, destination, steps);
}
