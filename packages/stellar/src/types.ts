export interface Position {
  x: number;
  y: number;
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
