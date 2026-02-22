"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useWallet } from "../../../lib/wallet-context";
import { useGame } from "../../../lib/use-game";
import { useLobbyStore } from "../../../stores/lobby-store";
import { useGameStore } from "../../../stores/game-store";
import { WalletButton } from "../../../components/WalletButton";
import { LobbyWaiting } from "../../../components/LobbyWaiting";
import { GameBoard } from "../../../components/GameBoard";
import { DiceRoll } from "../../../components/DiceRoll";
import { TurnControls } from "../../../components/TurnControls";
import { ScorePanel } from "../../../components/ScorePanel";
import { GameOver } from "../../../components/GameOver";
import { findPathTo } from "../../../lib/game-engine";
import { buildTurn } from "../../../lib/turn-builder";
import { usePrivateStore } from "../../../stores/private-store";
import {
  existsAnyPathLen,
  makeEffectiveWalls,
  type Position,
  HeistContractClient,
} from "@repo/stellar";
import { getRuntimeConfig } from "../../../lib/runtime-config";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

async function createHeistClient(): Promise<HeistContractClient> {
  const cfg = await getRuntimeConfig();
  return new HeistContractClient(cfg.heistContractId, cfg.rpcUrl || RPC_URL);
}

function isTimerExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("#16") || msg.toLowerCase().includes("timerexpired");
}

export default function GamePage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId: gameId } = use(params);
  const { address, connected, signTransaction, signAuthEntry } = useWallet();

  // Lobby store for join and phase tracking
  const { lobby, joinLobby: joinLobbyStore, loading: lobbyLoading, error: lobbyError, clearError } = useLobbyStore();

  // Game hook wires up all polling (lobby, auth, game state)
  const game = useGame(gameId, address ?? undefined, signAuthEntry);
  const { turnHistory } = useGameStore();

  const [selectedPath, setSelectedPath] = useState<Position[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [provingStep, setProvingStep] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const advancePosNonce = usePrivateStore((s) => s.advancePosNonce);
  const mapSeedReady    = usePrivateStore((s) => !!s.mapSeed);
  const posNonceReady   = usePrivateStore((s) => !!s.posNonce);

  // Reset path when the turn changes
  useEffect(() => {
    setSelectedPath([]);
    setTurnError(null);
  }, [game.view?.turnIndex]);

  // ─── Player 2 join via shared link ──────────────────────────────────────────

  const handleJoinFromLink = async () => {
    if (!address) return;
    setJoining(true);
    clearError();

    try {
      await joinLobbyStore(gameId, address);
    } catch {
      // Error stored in lobby store
    } finally {
      setJoining(false);
    }
  };

  // ─── Turn handling ──────────────────────────────────────────────────────────

  // ZK secrets must be ready before allowing turn submission.
  // mapSeed drives the map rendering; posNonce is needed for ZK proof.
  const zkSecretsReady = mapSeedReady && posNonceReady;

  const isMyTurn =
    game.view?.activePlayer === address && game.view?.status === "Active";

  const canSkip =
    isMyTurn &&
    game.roll !== null &&
    game.view !== null &&
    !existsAnyPathLen(
      makeEffectiveWalls(game.view.visibleWalls, game.view.myFog),
      address === game.view.player1
        ? game.view.player1Pos
        : game.view.player2Pos,
      1,
    );

  const handleCellClick = useCallback(
    (x: number, y: number) => {
      if (!isMyTurn || !game.view || !game.roll || !address) return;
      const path = findPathTo(game.view, address, { x, y }, game.roll);
      if (path) setSelectedPath(path);
    },
    [isMyTurn, game.view, game.roll, address],
  );

  /** Finalize a game whose timer expired by calling end_if_finished on-chain. */
  const handleTimerExpired = async () => {
    if (!address || !game.sessionId) return;
    try {
      const client = await createHeistClient();
      const txXdr = await client.buildEndIfFinishedTx(address, game.sessionId);
      const signedTx = await signTransaction(txXdr);
      await client.submitTx(signedTx);
    } catch (e) {
      console.warn("end_if_finished failed (may already be ended):", e);
    }
    await game.refreshGameState();
  };

  const handleSubmitTurn = async () => {
    if (!address || !game.view || !game.roll || !game.vkHash || !game.sessionId)
      return;

    setSubmitting(true);
    setTurnError(null);
    setProvingStep("Computing ZK inputs...");

    try {
      setProvingStep("Generating ZK proof (this may take a few minutes)...");

      const result = await buildTurn(
        address,
        game.sessionId,
        gameId,
        game.view,
        game.roll,
        selectedPath,
        game.vkHash,
      );

      const { txXdr, breakdown, newPosNonceHex, turn } = result;

      setProvingStep("Signing transaction...");
      const signedTx = await signTransaction(txXdr);

      setProvingStep("Submitting to blockchain...");
      const client = await createHeistClient();
      await client.submitTx(signedTx);

      // Advance pos nonce, position and loot mask now that the turn is confirmed.
      const endX = breakdown.path[breakdown.path.length - 1]?.x ?? breakdown.path[0]?.x ?? 1;
      const endY = breakdown.path[breakdown.path.length - 1]?.y ?? breakdown.path[0]?.y ?? 1;
      advancePosNonce(newPosNonceHex, endX, endY, turn.lootCollectedMaskDelta);

      game.recordTurn(breakdown);
      setSelectedPath([]);
      setProvingStep(null);
      await game.refreshGameState();
    } catch (err: unknown) {
      setProvingStep(null);
      if (isTimerExpiredError(err)) {
        await handleTimerExpired();
        return;
      }
      setTurnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkipTurn = async () => {
    if (!address || !game.view || !game.roll || !game.vkHash || !game.sessionId)
      return;

    const startPos =
      address === game.view.player1
        ? game.view.player1Pos
        : game.view.player2Pos;

    setSubmitting(true);
    setTurnError(null);
    setProvingStep("Generating ZK proof for skip turn...");

    try {
      const result = await buildTurn(
        address,
        game.sessionId,
        gameId,
        game.view,
        game.roll,
        [startPos],
        game.vkHash,
      );

      const { txXdr, breakdown, newPosNonceHex } = result;

      setProvingStep("Signing transaction...");
      const signedTx = await signTransaction(txXdr);

      setProvingStep("Submitting to blockchain...");
      const client = await createHeistClient();
      await client.submitTx(signedTx);

      // Skip turn: position stays at startPos — advance nonce, no loot collected.
      const sp = game.view!.player1 === address ? game.view!.player1Pos : game.view!.player2Pos;
      advancePosNonce(newPosNonceHex, sp.x, sp.y);

      game.recordTurn(breakdown);
      setSelectedPath([]);
      setProvingStep(null);
      await game.refreshGameState();
    } catch (err: unknown) {
      setProvingStep(null);
      if (isTimerExpiredError(err)) {
        await handleTimerExpired();
        return;
      }
      setTurnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClearPath = () => setSelectedPath([]);

  // ─── Render guards ──────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <h2 className="text-xl text-white">Connect your wallet to play</h2>
        <WalletButton />
      </div>
    );
  }

  // Player 2 join-via-link screen
  const isInLobby =
    lobby &&
    (lobby.player1 === address || lobby.player2 === address);

  if (lobby && !isInLobby && lobby.phase === "waiting") {
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
                {lobby.player1.slice(0, 6)}...{lobby.player1.slice(-4)}
              </span>
            </p>
            <button
              onClick={handleJoinFromLink}
              disabled={joining || lobbyLoading}
              className="w-full rounded-xl bg-heist-green/10 border-2 border-heist-green/30 px-6 py-4 text-lg font-semibold text-heist-green hover:bg-heist-green/20 hover:border-heist-green/50 disabled:opacity-50 transition-all glow-green"
            >
              {joining ? "Joining..." : "Join Game"}
            </button>
            {lobbyError && (
              <div className="rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red">
                {lobbyError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Pre-game lobby phases (waiting, starting, revealing, beginning)
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
            sessionId={lobby?.sessionId ?? game.sessionId ?? 0}
            player1={lobby?.player1 ?? ""}
            player2={lobby?.player2 ?? null}
            phase={lobby?.phase ?? game.lobbyPhase ?? "waiting"}
            error={lobby?.error ?? undefined}
          />
        </div>
      </div>
    );
  }

  // Active or ended game
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
          <GameBoard
            view={game.view}
            playerAddress={address!}
            roll={game.roll}
            selectedPath={selectedPath}
            onCellClick={handleCellClick}
            isMyTurn={isMyTurn}
          />

          <div className="w-full lg:w-72 space-y-4">
            <ScorePanel view={game.view} playerAddress={address!} turnHistory={turnHistory} />
            <DiceRoll value={game.roll} isMyTurn={isMyTurn} />

            {!zkSecretsReady && game.view?.status === "Active" && (
              <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-3 text-sm text-yellow-400 flex items-center gap-2">
                <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>ZK secrets loading… map will appear shortly.</span>
              </div>
            )}

            <TurnControls
              isMyTurn={isMyTurn && zkSecretsReady}
              selectedPath={selectedPath}
              roll={game.roll}
              onSubmit={handleSubmitTurn}
              onSkip={handleSkipTurn}
              onClear={handleClearPath}
              submitting={submitting}
              canSkip={canSkip && zkSecretsReady}
            />

            {provingStep && (
              <div className="rounded-lg bg-heist-green/10 border border-heist-green/30 p-3 text-sm text-heist-green flex items-center gap-2">
                <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>{provingStep}</span>
              </div>
            )}

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

        {game.view.status === "Ended" && (
          <GameOver view={game.view} playerAddress={address!} />
        )}
      </div>
    );
  }

  // Loading / error fallback
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4 max-w-sm px-4">
        {!game.error && (
          <svg className="animate-spin h-8 w-8 text-heist-green mx-auto" viewBox="0 0 24 24">
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
