"use client";

import { use, useState, useEffect, useCallback, useRef } from "react";
import { useWallet } from "../../../lib/wallet-context";
import { useSocket } from "../../../lib/socket-context";
import { useGame } from "../../../lib/use-game";
import { WalletButton } from "../../../components/WalletButton";
import { LobbyWaiting } from "../../../components/LobbyWaiting";
import { GameBoard } from "../../../components/GameBoard";
import { DiceRoll } from "../../../components/DiceRoll";
import { TurnControls } from "../../../components/TurnControls";
import { ScorePanel } from "../../../components/ScorePanel";
import { GameOver } from "../../../components/GameOver";
import { findPathTo } from "../../../lib/game-engine";
import { buildTurn } from "../../../lib/turn-builder";
import {
  existsAnyPathLen,
  makeEffectiveWalls,
  generateRandomSeed,
  commitHash,
  type Position,
  HeistContractClient,
} from "@repo/stellar";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const HEIST_CONTRACT =
  process.env.NEXT_PUBLIC_HEIST_CONTRACT_ID || "";
const ZK_VERIFIER_CONTRACT =
  process.env.NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID || "";

/** Returns true when a Soroban simulation/tx error is the TimerExpired (#16) contract error. */
function isTimerExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("#16") || msg.toLowerCase().includes("timerexpired");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function GamePage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId: gameId } = use(params);
  const { address, connected, signTransaction, signAuthEntry } = useWallet();
  const { socket } = useSocket();
  const game = useGame(gameId);

  const [selectedPath, setSelectedPath] = useState<Position[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [vkHash, setVkHash] = useState<Uint8Array | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const playerReadyEmitted = useRef(false);
  const [lobbyInfo, setLobbyInfo] = useState<{
    player1: string;
    player2: string | null;
    sessionId: number;
    phase: string;
  } | null>(null);

  // Fetch lobby info
  useEffect(() => {
    fetch(`${API_URL}/api/lobby/${gameId}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.error) {
          setLobbyInfo(data);
        }
      })
      .catch(() => {});
  }, [gameId]);

  // Update lobby info from socket
  useEffect(() => {
    if (!socket) return;
    const onLobbyState = (data: {
      player1: string;
      player2: string | null;
      sessionId: number;
      phase: string;
    }) => {
      setLobbyInfo(data);
    };
    socket.on("lobby_state", onLobbyState);
    return () => {
      socket.off("lobby_state", onLobbyState);
    };
  }, [socket]);

  // Fetch VK hash for proof construction
  useEffect(() => {
    const envVkHash = process.env.NEXT_PUBLIC_VK_HASH;
    if (envVkHash && envVkHash.length === 64) {
      setVkHash(hexToBytes(envVkHash));
      return;
    }
    if (!address) return;
    const client = new HeistContractClient(HEIST_CONTRACT, RPC_URL);
    client
      .getVkHash(ZK_VERIFIER_CONTRACT, address)
      .then((hash) => {
        if (hash) setVkHash(hash);
      })
      .catch(() => {});
  }, [address]);

  // Handle sign_auth_entry requests from server.
  // The backend runs authorizeEntry (Node.js) and sends us the preimage to sign.
  // We only call the wallet's signAuthEntry and return the raw signature.
  useEffect(() => {
    if (!socket || !address) return;

    const onSignAuthEntry = async (data: {
      gameId: string;
      purpose: string;
      targetPlayer: string;
      preimageXdr: string;
    }) => {
      if (data.gameId !== gameId) return;
      if (data.targetPlayer !== address) return;

      try {
        console.log(`Signing auth for: ${data.purpose}`);
        const signatureBase64 = await signAuthEntry(data.preimageXdr);
        socket.emit("auth_signature", {
          gameId: data.gameId,
          playerAddress: address,
          purpose: data.purpose,
          signatureBase64,
        });
      } catch (err) {
        console.error("Failed to sign auth entry:", err);
        socket.emit("error", {
          message: `Auth signing failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    socket.on("sign_auth_entry", onSignAuthEntry);
    return () => {
      socket.off("sign_auth_entry", onSignAuthEntry);
    };
  }, [socket, address, gameId, signAuthEntry]);

  // Trigger game start when player2 joins (emit only once)
  useEffect(() => {
    if (!socket || !lobbyInfo) return;
    if (
      lobbyInfo.player2 &&
      lobbyInfo.phase === "waiting" &&
      !playerReadyEmitted.current
    ) {
      playerReadyEmitted.current = true;
      socket.emit("player_ready", { gameId });
    }
  }, [socket, lobbyInfo, gameId]);

  // Reset path when turn changes
  useEffect(() => {
    setSelectedPath([]);
    setTurnError(null);
  }, [game.view?.turnIndex]);

  // Player 2 join handler (when opening shared link directly)
  const handleJoinFromLink = async () => {
    if (!address) return;
    setJoining(true);
    setJoinError(null);

    try {
      const seedSecret = generateRandomSeed();
      const seedCommit = commitHash(seedSecret);

      const res = await fetch(`${API_URL}/api/lobby/${gameId}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerAddress: address,
          seedCommit: bytesToHex(seedCommit),
          seedSecret: bytesToHex(seedSecret),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to join game");
      }

      const data = await res.json();
      setLobbyInfo((prev) =>
        prev
          ? { ...prev, player2: address, sessionId: data.sessionId }
          : {
              player1: data.player1,
              player2: address,
              sessionId: data.sessionId,
              phase: "waiting",
            },
      );
    } catch (err: unknown) {
      setJoinError(err instanceof Error ? err.message : "Failed to join game");
    } finally {
      setJoining(false);
    }
  };

  const isMyTurn =
    game.view?.activePlayer === address &&
    game.view?.status === "Active";

  // With partial-move rules the player may stop after 1..=rolled steps.
  // Therefore "skip" (no_path_flag) is only valid when even a SINGLE step is
  // impossible (player fully surrounded by walls in explored terrain).
  // We use effective walls (visible walls + fog) to prevent navigating into
  // unknown territory that could contain hidden walls.
  const canSkip =
    isMyTurn &&
    game.roll !== null &&
    game.view !== null &&
    !existsAnyPathLen(
      makeEffectiveWalls(game.view.visibleWalls, game.view.myFog),
      address === game.view.player1
        ? game.view.player1Pos
        : game.view.player2Pos,
      1, // partial-move: skip only when no 1-step move is possible
    );

  const handleCellClick = useCallback(
    (x: number, y: number) => {
      if (!isMyTurn || !game.view || !game.roll || !address) return;

      const path = findPathTo(game.view, address, { x, y }, game.roll);
      if (path) {
        setSelectedPath(path);
      }
    },
    [isMyTurn, game.view, game.roll, address],
  );

  /**
   * When `submit_turn` fails with TimerExpired (#16), the game timer has elapsed.
   * Because Soroban rolls back the transaction on error, the on-chain state is
   * still "Active".  We call `end_if_finished` as a separate transaction to
   * finalize the game, then refresh to show the Game Over screen.
   */
  const handleTimerExpired = async () => {
    if (!address || !game.sessionId) return;
    try {
      const client = new HeistContractClient(HEIST_CONTRACT, RPC_URL);
      const txXdr = await client.buildEndIfFinishedTx(address, game.sessionId);
      const signedTx = await signTransaction(txXdr);
      await client.submitTx(signedTx);
    } catch (e) {
      // Ignore — the game might already be ended by someone else
      console.warn("end_if_finished failed (may already be ended):", e);
    }
    await game.refreshGameState();
  };

  const handleSubmitTurn = async () => {
    if (
      !address ||
      !game.view ||
      !game.roll ||
      !vkHash ||
      !game.sessionId
    )
      return;

    setSubmitting(true);
    setTurnError(null);

    try {
      const { txXdr } = await buildTurn(
        address,
        game.sessionId,
        game.view,
        game.roll,
        selectedPath,
        vkHash,
      );

      const signedTx = await signTransaction(txXdr);

      const client = new HeistContractClient(HEIST_CONTRACT, RPC_URL);
      await client.submitTx(signedTx);

      socket?.emit("turn_submitted", {
        gameId,
        playerAddress: address,
      });

      setSelectedPath([]);
      await game.refreshGameState();
    } catch (err: unknown) {
      if (isTimerExpiredError(err)) {
        // Game timer ran out — finalize and show results
        await handleTimerExpired();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setTurnError(msg);
      console.error("Turn submission failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkipTurn = async () => {
    if (!address || !game.view || !game.roll || !vkHash || !game.sessionId)
      return;

    const startPos =
      address === game.view.player1
        ? game.view.player1Pos
        : game.view.player2Pos;

    setSubmitting(true);
    setTurnError(null);

    try {
      const { txXdr } = await buildTurn(
        address,
        game.sessionId,
        game.view,
        game.roll,
        [startPos],
        vkHash,
      );

      const signedTx = await signTransaction(txXdr);
      const client = new HeistContractClient(HEIST_CONTRACT, RPC_URL);
      await client.submitTx(signedTx);

      socket?.emit("turn_submitted", {
        gameId,
        playerAddress: address,
      });

      setSelectedPath([]);
      await game.refreshGameState();
    } catch (err: unknown) {
      if (isTimerExpiredError(err)) {
        await handleTimerExpired();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setTurnError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClearPath = () => {
    setSelectedPath([]);
  };

  // Not connected
  if (!connected) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <h2 className="text-xl text-white">
          Connect your wallet to play
        </h2>
        <WalletButton />
      </div>
    );
  }

  // Player 2 needs to join the game (opened shared link, not yet in lobby)
  const isInLobby =
    lobbyInfo &&
    (lobbyInfo.player1 === address || lobbyInfo.player2 === address);

  if (lobbyInfo && !isInLobby && lobbyInfo.phase === "waiting") {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-heist-border">
          <a href="/" className="text-xl font-bold text-white">
            <span className="text-heist-green">Heist</span> Duel
          </a>
          <WalletButton />
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-md rounded-xl bg-heist-card border border-heist-border p-8 text-center space-y-6">
            <h2 className="text-2xl font-bold text-white">Join Game</h2>
            <p className="text-gray-400">
              You have been invited to a Heist Duel match against{" "}
              <span className="font-mono text-player1">
                {lobbyInfo.player1.slice(0, 6)}...{lobbyInfo.player1.slice(-4)}
              </span>
            </p>
            <button
              onClick={handleJoinFromLink}
              disabled={joining}
              className="w-full rounded-xl bg-heist-green/10 border-2 border-heist-green/30 px-6 py-4 text-lg font-semibold text-heist-green hover:bg-heist-green/20 hover:border-heist-green/50 disabled:opacity-50 transition-all glow-green"
            >
              {joining ? "Joining..." : "Join Game"}
            </button>
            {joinError && (
              <div className="rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red">
                {joinError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Pre-game lobby phases
  if (
    !game.view &&
    game.lobbyPhase !== "active" &&
    game.lobbyPhase !== "ended"
  ) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-heist-border">
          <a href="/" className="text-xl font-bold text-white">
            <span className="text-heist-green">Heist</span> Duel
          </a>
          <WalletButton />
        </header>
        <div className="flex-1 flex items-center justify-center">
          <LobbyWaiting
            gameId={gameId}
            sessionId={lobbyInfo?.sessionId || game.sessionId || 0}
            player1={lobbyInfo?.player1 || ""}
            player2={lobbyInfo?.player2 || null}
            phase={lobbyInfo?.phase || game.lobbyPhase || "waiting"}
          />
        </div>
      </div>
    );
  }

  // Active game or ended
  if (game.view) {
    return (
      <div className="min-h-screen flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-heist-border">
          <a href="/" className="text-xl font-bold text-white">
            <span className="text-heist-green">Heist</span> Duel
          </a>
          <WalletButton />
        </header>

        <div className="flex-1 flex flex-col lg:flex-row gap-4 p-4 items-start justify-center">
          {/* Board */}
          <GameBoard
            view={game.view}
            playerAddress={address!}
            roll={game.roll}
            selectedPath={selectedPath}
            onCellClick={handleCellClick}
            isMyTurn={isMyTurn}
          />

          {/* Side panel */}
          <div className="w-full lg:w-72 space-y-4">
            <ScorePanel view={game.view} playerAddress={address!} />

            <DiceRoll value={game.roll} isMyTurn={isMyTurn} />

            <TurnControls
              isMyTurn={isMyTurn}
              selectedPath={selectedPath}
              roll={game.roll}
              onSubmit={handleSubmitTurn}
              onSkip={handleSkipTurn}
              onClear={handleClearPath}
              submitting={submitting}
              canSkip={canSkip}
            />

            {turnError && (
              <div className="rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red">
                {turnError}
              </div>
            )}

            {game.error && (
              <div className="rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red">
                {game.error}
              </div>
            )}

            <button
              onClick={game.refreshGameState}
              disabled={game.loading}
              className="w-full rounded-lg bg-heist-card border border-heist-border px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              {game.loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>

        {/* Game Over overlay */}
        {game.view.status === "Ended" && (
          <GameOver view={game.view} playerAddress={address!} />
        )}
      </div>
    );
  }

  // Loading / error state (game is active on-chain but view not yet loaded)
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4 max-w-sm px-4">
        {!game.error && (
          <svg
            className="animate-spin h-8 w-8 text-heist-green mx-auto"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
              fill="none"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        <p className="text-gray-400">
          {game.error ? "Failed to load game state" : "Loading game state..."}
        </p>
        {game.error && (
          <div className="rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red text-left break-all">
            {game.error}
          </div>
        )}
        {game.lobbyPhase === "active" && (
          <button
            onClick={() => void game.refreshGameState()}
            disabled={game.loading}
            className="mt-2 rounded-lg bg-heist-card border border-heist-border px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
          >
            {game.loading ? "Loading..." : "Retry"}
          </button>
        )}
      </div>
    </div>
  );
}
