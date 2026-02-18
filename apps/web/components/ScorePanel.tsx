"use client";

import { useState, useEffect } from "react";
import type { PlayerGameView } from "@repo/stellar";

interface ScorePanelProps {
  view: PlayerGameView;
  playerAddress: string;
}

export function ScorePanel({ view, playerAddress }: ScorePanelProps) {
  const isPlayer1 = playerAddress === view.player1;
  const isMyTurn = view.activePlayer === playerAddress;

  const [timeLeft, setTimeLeft] = useState<number | null>(null);

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

  return (
    <div className="rounded-xl bg-heist-card border border-heist-border p-4 space-y-4">
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
        <div className="text-xs text-gray-500 mt-1">
          Turn #{view.turnIndex}
        </div>
      </div>
    </div>
  );
}
