"use client";

import { useState, useEffect } from "react";
import type { PlayerGameView } from "@repo/stellar";
import type { TurnBreakdown } from "../lib/turn-builder";

interface ScorePanelProps {
  view: PlayerGameView;
  playerAddress: string;
  turnHistory?: TurnBreakdown[];
}

function TurnRow({ t }: { t: TurnBreakdown }) {
  const sign = (n: bigint) => (n > 0n ? `+${n}` : `${n}`);
  const color =
    t.scoreDelta > 0n
      ? "text-heist-green"
      : t.scoreDelta < 0n
        ? "text-heist-red"
        : "text-gray-400";

  const parts: string[] = [];
  if (t.noPathFlag) {
    parts.push("skip");
  } else {
    if (t.exitedFlag) parts.push("exited ✓");
    if (t.lootItems > 0) parts.push(`+${t.lootItems} loot`);
    if (t.cameraHits > 0) parts.push(`${t.cameraHits} cam`);
    if (t.laserHits > 0) parts.push(`${t.laserHits} laser`);
    if (parts.length === 0) parts.push("no loot");
  }

  return (
    <div className="flex items-center justify-between text-xs py-0.5 border-b border-heist-border/30 last:border-0">
      <span className="text-gray-500 font-mono w-10">#{t.turnIndex}</span>
      <span className="text-gray-400 flex-1 truncate px-1">{parts.join(", ")}</span>
      <span className={`font-mono font-semibold ${color}`}>{sign(t.scoreDelta)}</span>
    </div>
  );
}

/**
 * Compute the effective seconds remaining for the current player's turn,
 * accounting for the time already elapsed since the turn started.
 *
 * The on-chain clock is only decremented when submit_turn is called;
 * we compute the live value client-side to give a real-time countdown.
 */
function computeEffectiveTimeLeft(
  remainingSeconds: number,
  lastTurnStartTs: number,
  isMyTurn: boolean,
): number {
  if (!isMyTurn) return remainingSeconds;
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(0, nowSec - lastTurnStartTs);
  return Math.max(0, remainingSeconds - elapsed);
}

export function ScorePanel({ view, playerAddress, turnHistory = [] }: ScorePanelProps) {
  const isPlayer1 = playerAddress === view.player1;
  const isMyTurn  = view.activePlayer === playerAddress;

  // Per-player chess clock — only show own time (opponent's is hidden by design).
  const [myTimeLeft, setMyTimeLeft] = useState<number>(
    computeEffectiveTimeLeft(view.myTimeRemaining, view.lastTurnStartTs, isMyTurn),
  );

  useEffect(() => {
    const update = () => {
      setMyTimeLeft(
        computeEffectiveTimeLeft(view.myTimeRemaining, view.lastTurnStartTs, isMyTurn),
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [view.myTimeRemaining, view.lastTurnStartTs, isMyTurn]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const myScore       = isPlayer1 ? view.player1Score : view.player2Score;
  const opponentScore = isPlayer1 ? view.player2Score : view.player1Score;

  // Last turn submitted by me (most recent first)
  const myHistory = [...turnHistory].reverse();
  const lastTurn  = myHistory[0] ?? null;
  const [showHistory, setShowHistory] = useState(false);

  return (
    <div className="rounded-xl bg-heist-card border border-heist-border p-4 space-y-4">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Score
        </h3>
        {/* Own chess clock — never show opponent's */}
        <div className="flex items-center gap-2">
          {view.myExited && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-heist-green/20 text-heist-green border border-heist-green/30 font-semibold">
              Exited ✓
            </span>
          )}
          <span
            className={`font-mono text-sm ${
              isMyTurn && myTimeLeft < 30
                ? "text-heist-red animate-pulse"
                : isMyTurn
                  ? "text-heist-green"
                  : "text-gray-500"
            }`}
            title="Your remaining time"
          >
            {formatTime(myTimeLeft)}
          </span>
        </div>
      </div>

      {/* ── Score rows ─────────────────────────────────────────── */}
      <div className="space-y-2">
        {/* My score */}
        <div
          className={`flex justify-between items-center p-2 rounded-lg ${
            isPlayer1
              ? "bg-player1/10 border border-player1/20"
              : "bg-player2/10 border border-player2/20"
          } ${
            isMyTurn ? "ring-1 ring-heist-green/40" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                isPlayer1 ? "bg-player1" : "bg-player2"
              }`}
            />
            <span className="text-sm text-gray-300">You</span>
            {isMyTurn && (
              <span className="text-xs text-heist-green font-mono">◂ turn</span>
            )}
          </div>
          <span className="font-mono font-bold text-white">
            {myScore.toString()}
          </span>
        </div>

        {/* Opponent score */}
        <div
          className={`flex justify-between items-center p-2 rounded-lg ${
            !isPlayer1
              ? "bg-player1/10 border border-player1/20"
              : "bg-player2/10 border border-player2/20"
          } ${
            !isMyTurn && view.status === "Active" ? "ring-1 ring-gray-500/30" : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                !isPlayer1 ? "bg-player1" : "bg-player2"
              }`}
            />
            <span className="text-sm text-gray-300">Opponent</span>
            {!isMyTurn && view.status === "Active" && (
              <span className="text-xs text-gray-500 font-mono">◂ turn</span>
            )}
          </div>
          <span className="font-mono font-bold text-white">
            {opponentScore.toString()}
          </span>
        </div>
      </div>

      {/* ── Turn status ────────────────────────────────────────── */}
      <div className="text-center">
        <span
          className={`text-xs px-3 py-1 rounded-full ${
            isMyTurn
              ? "bg-heist-green/20 text-heist-green"
              : "bg-gray-700/50 text-gray-400"
          }`}
        >
          {isMyTurn ? "Your turn" : "Opponent's turn"}
        </span>
        <div className="text-xs text-gray-500 mt-1">Turn #{view.turnIndex}</div>
      </div>

      {/* ── Last turn summary ──────────────────────────────────── */}
      {lastTurn && (
        <div
          className={`rounded-lg p-2 text-xs border ${
            lastTurn.exitedFlag
              ? "bg-heist-green/10 border-heist-green/30"
              : lastTurn.scoreDelta > 0n
                ? "bg-heist-green/5 border-heist-green/20"
                : lastTurn.scoreDelta < 0n
                  ? "bg-heist-red/5 border-heist-red/20"
                  : "bg-heist-darker border-heist-border/30"
          }`}
        >
          <div className="flex justify-between items-center mb-1">
            <span className="text-gray-400 font-semibold">
              Last turn #{lastTurn.turnIndex}
              {lastTurn.exitedFlag && (
                <span className="ml-1 text-heist-green">— Exited!</span>
              )}
            </span>
            <span
              className={`font-mono font-bold ${
                lastTurn.scoreDelta > 0n
                  ? "text-heist-green"
                  : lastTurn.scoreDelta < 0n
                    ? "text-heist-red"
                    : "text-gray-400"
              }`}
            >
              {lastTurn.scoreDelta > 0n ? "+" : ""}{lastTurn.scoreDelta.toString()} pts
            </span>
          </div>
          {lastTurn.noPathFlag ? (
            <p className="text-gray-500">No move available (skip)</p>
          ) : (
            <div className="space-y-0.5 text-gray-400">
              {lastTurn.lootItems > 0 && (
                <div className="flex justify-between">
                  <span>Loot collected</span>
                  <span className="text-heist-gold font-mono">+{lastTurn.lootItems} pts</span>
                </div>
              )}
              {lastTurn.cameraHits > 0 && (
                <div className="flex justify-between">
                  <span>Camera hit ×{lastTurn.cameraHits}</span>
                  <span className="text-heist-red font-mono">−{lastTurn.cameraHits} pts</span>
                </div>
              )}
              {lastTurn.laserHits > 0 && (
                <div className="flex justify-between">
                  <span>Laser hit ×{lastTurn.laserHits}</span>
                  <span className="text-heist-red font-mono">−{lastTurn.laserHits * 2} pts</span>
                </div>
              )}
              {lastTurn.lootItems === 0 && lastTurn.cameraHits === 0 && lastTurn.laserHits === 0 && !lastTurn.exitedFlag && (
                <p className="text-gray-500">No loot, no hazards</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Turn history (collapsible) ─────────────────────────── */}
      {myHistory.length > 1 && (
        <div>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="w-full text-xs text-gray-500 hover:text-gray-300 transition-colors text-left flex justify-between items-center"
          >
            <span>Turn history ({myHistory.length})</span>
            <span>{showHistory ? "▲" : "▼"}</span>
          </button>

          {showHistory && (
            <div className="mt-2 space-y-0 max-h-40 overflow-y-auto">
              {myHistory.map((t) => (
                <TurnRow key={t.turnIndex} t={t} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
