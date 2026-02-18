import type { LobbyData } from "../types.js";

const lobbies = new Map<string, LobbyData>();
const activeSessionIds = new Set<number>();

function generateSessionId(): number {
  // Use a randomized 31-bit positive integer to avoid reusing fixed IDs (e.g. 1000)
  // after API restarts, which can collide with already created on-chain games.
  for (let i = 0; i < 64; i++) {
    const candidate = Math.floor(Math.random() * 0x7fffffff) + 1;
    if (!activeSessionIds.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate unique sessionId");
}

export function createLobby(
  gameId: string,
  player1: string,
  seedCommit: string,
): LobbyData {
  const sessionId = generateSessionId();
  const lobby: LobbyData = {
    gameId,
    sessionId,
    player1,
    player1SeedCommit: seedCommit,
    player1SeedSecret: null,
    player2: null,
    player2SeedCommit: null,
    player2SeedSecret: null,
    phase: "waiting",
    createdAt: Date.now(),
  };
  lobbies.set(gameId, lobby);
  activeSessionIds.add(sessionId);
  return lobby;
}

export function getLobby(gameId: string): LobbyData | undefined {
  return lobbies.get(gameId);
}

export function updateLobby(
  gameId: string,
  updates: Partial<LobbyData>,
): LobbyData | undefined {
  const lobby = lobbies.get(gameId);
  if (!lobby) return undefined;
  Object.assign(lobby, updates);
  return lobby;
}

export function deleteLobby(gameId: string): void {
  const lobby = lobbies.get(gameId);
  if (lobby) {
    activeSessionIds.delete(lobby.sessionId);
  }
  lobbies.delete(gameId);
}

export function listLobbies(): LobbyData[] {
  return Array.from(lobbies.values());
}
