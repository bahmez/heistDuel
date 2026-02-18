export interface LobbyData {
  gameId: string;
  sessionId: number;
  player1: string;
  player1SeedCommit: string;
  player1SeedSecret: string | null;
  player2: string | null;
  player2SeedCommit: string | null;
  player2SeedSecret: string | null;
  phase:
    | "waiting"
    | "starting"
    | "revealing"
    | "beginning"
    | "active"
    | "ended"
    | "error";
  error?: string;
  createdAt: number;
}

export interface AuthRequest {
  gameId: string;
  playerAddress: string;
  authEntryXdr: string;
  purpose: "start_game" | "reveal_seed" | "begin_match";
}
