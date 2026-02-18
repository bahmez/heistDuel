"use client";

import type { PlayerGameView } from "@repo/stellar";

interface GameOverProps {
  view: PlayerGameView;
  playerAddress: string;
}

export function GameOver({ view, playerAddress }: GameOverProps) {
  const isWinner = view.winner === playerAddress;
  const isDraw =
    view.player1Score === view.player2Score;
  const isPlayer1 = playerAddress === view.player1;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="rounded-2xl bg-heist-card border border-heist-border p-8 max-w-sm w-full text-center space-y-6">
        <div
          className={`text-6xl ${
            isWinner ? "glow-green" : "glow-red"
          } inline-block rounded-full p-4`}
        >
          {isWinner ? "🏆" : "💀"}
        </div>

        <div>
          <h2 className="text-2xl font-bold text-white">
            {isDraw ? "Draw!" : isWinner ? "Victory!" : "Defeat"}
          </h2>
          <p className="text-gray-400 mt-1">
            {isDraw
              ? "The match ended in a tie."
              : isWinner
                ? "You won the heist!"
                : "Better luck next time."}
          </p>
        </div>

        <div className="rounded-xl bg-heist-darker p-4 space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-400">
              {isPlayer1 ? "Your score" : "Opponent"}
            </span>
            <span className="font-mono font-bold text-player1">
              {view.player1Score.toString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">
              {!isPlayer1 ? "Your score" : "Opponent"}
            </span>
            <span className="font-mono font-bold text-player2">
              {view.player2Score.toString()}
            </span>
          </div>
        </div>

        <a
          href="/"
          className="inline-block w-full rounded-lg bg-heist-green/20 border border-heist-green/40 px-6 py-3 text-heist-green font-semibold hover:bg-heist-green/30 transition-all"
        >
          Play Again
        </a>
      </div>
    </div>
  );
}
