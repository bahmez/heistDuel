export interface Position {
  x: number;
  y: number;
}

/**
 * A player's current position, known only to them (tracked locally from
 * the spawn point through each submitted turn).
 */
export interface PlayerPos {
  x: number;
  y: number;
}

/**
 * Extended game view enriched with locally-tracked private data:
 * actual player positions (derived from posNonce) and the full map
 * (derived from mapSeed).
 */
export interface PlayerGameView extends GameView {
  /** My actual current position (tracked locally, not stored on-chain). */
  player1Pos: PlayerPos;
  player2Pos: PlayerPos;
  /** Full map data (walls, loot, cameras, lasers) derived from mapSeed. */
  visibleWalls: Uint8Array;
  visibleLoot:  Uint8Array;
  visibleCameras: import('./engine').Camera[];
  visibleLasers:  import('./engine').Laser[];
  /** Which loot items have been collected globally (inferred from lootTotalCollected). */
  lootCollected: Uint8Array;
  /**
   * Fog bitset — cells the player cannot see.
   * Currently set to all-zero (full visibility since the player knows the full map).
   */
  myFog: Uint8Array;
}

/**
 * Full turn data used to build a submit_turn transaction.
 * This is the "extended" form used internally by turn-builder.ts;
 * the on-chain form is TurnZkPublic.
 */
export interface TurnPublic extends TurnZkPublic {
  /** The player's start position this turn. */
  startPos: PlayerPos;
  /** The player's end position this turn. */
  endPos: PlayerPos;
  /** Dice roll value for this turn. */
  rolledValue: number;
  /** Camera hits this turn. */
  cameraHits: number;
  /** Laser hits this turn. */
  laserHits: number;
  /** Bitset of loot items collected this turn. */
  lootCollectedMaskDelta: Uint8Array;
  /** Path taken this turn. */
  path: PlayerPos[];
}

export type GameStatus = "WaitingReveal" | "Active" | "Ended";

/** ZK-private turn data. Only public outputs are revealed on-chain. */
export interface TurnZkPublic {
  sessionId: number;
  turnIndex: number;
  player: string;
  /** Net score change (loot gained minus hazard penalties). Can be negative. */
  scoreDelta: bigint;
  /** Number of new loot items collected this turn (always >= 0). */
  lootDelta: number;
  /** Position commitment before the move: keccak(x ‖ y ‖ pos_nonce). */
  posCommitBefore: Uint8Array;
  /** Position commitment after the move. */
  posCommitAfter: Uint8Array;
  /** State commitment before the move (must match on-chain state_commitment). */
  stateCommitBefore: Uint8Array;
  /** State commitment after the move (becomes new on-chain state_commitment). */
  stateCommitAfter: Uint8Array;
  /** True when the player has no valid moves. */
  noPathFlag: boolean;
}

/** Public view of the ZK game state — only commitments, no raw map or positions. */
export interface GameView {
  player1: string;
  player2: string;
  status: GameStatus;
  startedAtTs: number | null;
  deadlineTs: number | null;
  turnIndex: number;
  activePlayer: string;
  player1Score: bigint;
  player2Score: bigint;
  lootTotalCollected: number;
  mapCommitment: Uint8Array;
  player1PosCommit: Uint8Array;
  player2PosCommit: Uint8Array;
  p1MapSeedCommit: Uint8Array;
  p2MapSeedCommit: Uint8Array;
  stateCommitment: Uint8Array;
  winner: string | null;
  lastProofId: Uint8Array | null;
}
