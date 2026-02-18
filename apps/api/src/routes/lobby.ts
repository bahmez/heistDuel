import { Router, type Request, type Response, type Router as RouterType } from "express";
import { v4 as uuidv4 } from "uuid";
import { createLobby, getLobby, updateLobby } from "../services/lobby-store.js";

const router: RouterType = Router();

/**
 * POST /api/lobby
 * Body: { playerAddress: string, seedCommit: string }
 * seedCommit is hex-encoded 32-byte keccak256 hash of the player's seed secret
 */
router.post("/", (req: Request, res: Response) => {
  const { playerAddress, seedCommit, seedSecret } = req.body as {
    playerAddress?: string;
    seedCommit?: string;
    seedSecret?: string;
  };

  if (!playerAddress || !seedCommit) {
    res.status(400).json({ error: "playerAddress and seedCommit required" });
    return;
  }

  const gameId = uuidv4().slice(0, 8);
  const lobby = createLobby(gameId, playerAddress, seedCommit);

  if (seedSecret) {
    updateLobby(gameId, { player1SeedSecret: seedSecret });
  }

  res.json({
    gameId: lobby.gameId,
    sessionId: lobby.sessionId,
    joinUrl: `/game/${gameId}`,
  });
});

/**
 * POST /api/lobby/:gameId/join
 * Body: { playerAddress: string, seedCommit: string }
 */
router.post("/:gameId/join", (req: Request, res: Response) => {
  const gameId = String(req.params.gameId);
  const { playerAddress, seedCommit, seedSecret } = req.body as {
    playerAddress?: string;
    seedCommit?: string;
    seedSecret?: string;
  };

  if (!playerAddress || !seedCommit) {
    res.status(400).json({ error: "playerAddress and seedCommit required" });
    return;
  }

  const lobby = getLobby(gameId);
  if (!lobby) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  if (lobby.phase !== "waiting") {
    res.status(400).json({ error: "Game already started" });
    return;
  }

  if (lobby.player1 === playerAddress) {
    res.status(400).json({ error: "Cannot join your own game" });
    return;
  }

  updateLobby(gameId, {
    player2: playerAddress,
    player2SeedCommit: seedCommit,
    player2SeedSecret: seedSecret || null,
  });

  res.json({
    gameId: lobby.gameId,
    sessionId: lobby.sessionId,
    player1: lobby.player1,
    player2: playerAddress,
  });
});

/**
 * GET /api/lobby/:gameId
 */
router.get("/:gameId", (req: Request, res: Response) => {
  const gameId = String(req.params.gameId);
  const lobby = getLobby(gameId);
  if (!lobby) {
    res.status(404).json({ error: "Game not found" });
    return;
  }

  res.json({
    gameId: lobby.gameId,
    sessionId: lobby.sessionId,
    player1: lobby.player1,
    player2: lobby.player2,
    phase: lobby.phase,
    createdAt: lobby.createdAt,
    error: lobby.error,
  });
});

export default router;
