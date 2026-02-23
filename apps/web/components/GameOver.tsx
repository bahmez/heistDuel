"use client";

import type { PlayerGameView } from "@repo/stellar";

interface GameOverProps {
  view: PlayerGameView;
  playerAddress: string;
  contractId?: string;
  sessionId?: number | null;
  network?: string;
}

export function GameOver({ view, playerAddress, contractId, sessionId, network = "testnet" }: GameOverProps) {
  const isPlayer1 = playerAddress === view.player1;
  const isWinner  = view.winner === playerAddress;

  const myScore       = isPlayer1 ? view.player1Score : view.player2Score;
  const opponentScore = isPlayer1 ? view.player2Score : view.player1Score;

  const myExited       = view.myExited;
  const opponentExited = view.opponentExited;
  const bothExited     = myExited && opponentExited;
  const neitherExited  = !myExited && !opponentExited;

  // Determine win reason for messaging.
  const getWinReason = () => {
    if (isWinner) {
      if (bothExited) {
        if (myScore > opponentScore) return "You had the highest score after escaping!";
        return "You escaped first — tiebreaker victory!";
      }
      if (myExited && !opponentExited) return "You escaped — opponent's time ran out.";
      if (neitherExited) return "Opponent's time ran out — score tiebreak.";
      return "You won the heist!";
    } else {
      if (bothExited) {
        if (opponentScore > myScore) return "Opponent had a higher score.";
        return "Opponent escaped first — tiebreaker loss.";
      }
      if (!myExited && opponentExited) return "You didn't escape in time.";
      if (neitherExited) return "Your time ran out.";
      return "Better luck next time.";
    }
  };

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
            {isWinner ? "Victory!" : "Defeat"}
          </h2>
          <p className="text-gray-400 mt-1 text-sm">{getWinReason()}</p>
        </div>

        {/* Exit status badges */}
        <div className="flex justify-center gap-3 text-xs">
          <span
            className={`px-3 py-1 rounded-full border font-semibold ${
              myExited
                ? "bg-heist-green/20 text-heist-green border-heist-green/30"
                : "bg-gray-700/30 text-gray-500 border-gray-600/30"
            }`}
          >
            You: {myExited ? "Escaped ✓" : "Trapped"}
          </span>
          <span
            className={`px-3 py-1 rounded-full border font-semibold ${
              opponentExited
                ? "bg-heist-green/20 text-heist-green border-heist-green/30"
                : "bg-gray-700/30 text-gray-500 border-gray-600/30"
            }`}
          >
            Opp: {opponentExited ? "Escaped ✓" : "Trapped"}
          </span>
        </div>

        <div className="rounded-xl bg-heist-darker p-4 space-y-2">
          <div className="flex justify-between">
            <span className="text-gray-400">Your score</span>
            <span
              className={`font-mono font-bold ${
                isPlayer1 ? "text-player1" : "text-player2"
              }`}
            >
              {myScore.toString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Opponent score</span>
            <span
              className={`font-mono font-bold ${
                !isPlayer1 ? "text-player1" : "text-player2"
              }`}
            >
              {opponentScore.toString()}
            </span>
          </div>
        </div>

        {/* Explorer link */}
        {contractId && (
          <div className="rounded-xl bg-heist-darker border border-heist-border/50 p-3 space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold">
              On-chain contract
            </p>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-gray-400 truncate">
                {contractId.slice(0, 8)}…{contractId.slice(-8)}
                {sessionId != null && (
                  <span className="text-gray-600 ml-1">#{sessionId}</span>
                )}
              </span>
              <a
                href={`https://stellar.expert/explorer/${network}/contract/${contractId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0 flex items-center gap-1 text-xs text-heist-blue hover:text-white transition-colors"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                stellar.expert
              </a>
            </div>
          </div>
        )}

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
