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

export function ScorePanel({ view, playerAddress, turnHistory = [] }: ScorePanelProps) {
  const isPlayer1 = playerAddress === view.player1;
  const isMyTurn = view.activePlayer === playerAddress;

  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (!view.deadlineTs) return;

    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      const left = Number(view.deadlineTs) - now;
      setTimeLeft(Math.max(0, left));
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [view.deadlineTs]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // Last turn submitted by me (most recent first)
  const myHistory = [...turnHistory].reverse();
  const lastTurn = myHistory[0] ?? null;

  return (
    <div className="rounded-xl bg-heist-card border border-heist-border p-4 space-y-4">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Score
        </h3>
        {timeLeft !== null && (
          <span
            className={`font-mono text-sm ${
              timeLeft < 30 ? "text-heist-red" : "text-gray-300"
            }`}
          >
            {formatTime(timeLeft)}
          </span>
        )}
      </div>

      {/* ── Score rows ─────────────────────────────────────────── */}
      <div className="space-y-2">
        <div
          className={`flex justify-between items-center p-2 rounded-lg ${
            isPlayer1
              ? "bg-player1/10 border border-player1/20"
              : "bg-heist-darker"
          } ${
            view.activePlayer === view.player1
              ? "animate-pulse-border border border-player1/40"
              : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-player1" />
            <span className="text-sm text-gray-300">
              {isPlayer1 ? "You" : "Opponent"}
            </span>
          </div>
          <span className="font-mono font-bold text-white">
            {view.player1Score.toString()}
          </span>
        </div>

        <div
          className={`flex justify-between items-center p-2 rounded-lg ${
            !isPlayer1
              ? "bg-player2/10 border border-player2/20"
              : "bg-heist-darker"
          } ${
            view.activePlayer === view.player2
              ? "animate-pulse-border border border-player2/40"
              : ""
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-player2" />
            <span className="text-sm text-gray-300">
              {!isPlayer1 ? "You" : "Opponent"}
            </span>
          </div>
          <span className="font-mono font-bold text-white">
            {view.player2Score.toString()}
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
            lastTurn.scoreDelta > 0n
              ? "bg-heist-green/5 border-heist-green/20"
              : lastTurn.scoreDelta < 0n
                ? "bg-heist-red/5 border-heist-red/20"
                : "bg-heist-darker border-heist-border/30"
          }`}
        >
          <div className="flex justify-between items-center mb-1">
            <span className="text-gray-400 font-semibold">Last turn #{lastTurn.turnIndex}</span>
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
              {lastTurn.lootItems === 0 && lastTurn.cameraHits === 0 && lastTurn.laserHits === 0 && (
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
