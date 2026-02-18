export interface Position {
  x: number;
  y: number;
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

export type GameStatus = "WaitingReveal" | "Active" | "Ended";

export interface PlayerGameView {
  player1: string;
  player2: string;
  status: GameStatus;
  startedAtTs: number | null;
  deadlineTs: number | null;
  turnIndex: number;
  activePlayer: string;
  player1Pos: Position;
  player2Pos: Position;
  player1Score: bigint;
  player2Score: bigint;
  lootCollected: Uint8Array;
  visibleWalls: Uint8Array;
  visibleLoot: Uint8Array;
  visibleCameras: Camera[];
  visibleLasers: Laser[];
  myFog: Uint8Array;
  winner: string | null;
  lastProofId: Uint8Array | null;
}

export interface TurnPublic {
  sessionId: number;
  turnIndex: number;
  player: string;
  startPos: Position;
  endPos: Position;
  rolledValue: number;
  scoreDelta: bigint;
  cameraHits: number;
  laserHits: number;
  lootCollectedMaskDelta: Uint8Array;
  noPathFlag: boolean;
  stateHashBefore: Uint8Array;
  stateHashAfter: Uint8Array;
  path: Position[];
}

export interface LobbyState {
  gameId: string;
  sessionId: number;
  player1: string;
  player1SeedCommit: Uint8Array;
  player1SeedSecret: Uint8Array | null;
  player2: string | null;
  player2SeedCommit: Uint8Array | null;
  player2SeedSecret: Uint8Array | null;
  phase:
    | "waiting"
    | "starting"
    | "revealing"
    | "beginning"
    | "active"
    | "ended";
  createdAt: number;
}
