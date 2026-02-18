"use client";

import { useState } from "react";

interface LobbyWaitingProps {
  gameId: string;
  sessionId: number;
  player1: string;
  player2: string | null;
  phase: string;
  error?: string;
}

export function LobbyWaiting({
  gameId,
  sessionId,
  player1,
  player2,
  phase,
  error,
}: LobbyWaitingProps) {
  const [copied, setCopied] = useState(false);
  const appUrlFromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  const appBaseUrl = appUrlFromEnv.replace(/\/+$/, "");
  const joinUrl =
    appBaseUrl
      ? `${appBaseUrl}/game/${gameId}`
      : typeof window !== "undefined"
        ? `${window.location.origin}/game/${gameId}`
        : `/game/${gameId}`;

  const copyLink = () => {
    navigator.clipboard.writeText(joinUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const phaseLabels: Record<string, string> = {
    waiting: "Waiting for opponent...",
    starting: "Starting game on-chain...",
    revealing: "Revealing seeds...",
    beginning: "Initializing match...",
    active: "Game active!",
    error: "An error occurred",
  };

  return (
    <div className="flex flex-col items-center gap-6 p-8">
      <div className="w-full max-w-md rounded-xl bg-heist-card border border-heist-border p-6">
        <h2 className="text-xl font-bold text-white mb-4">Game Lobby</h2>

        <div className="space-y-3 mb-6">
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Session</span>
            <span className="font-mono text-heist-green">#{sessionId}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Player 1</span>
            <span className="font-mono text-player1">
              {player1.slice(0, 6)}...{player1.slice(-4)}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Player 2</span>
            {player2 ? (
              <span className="font-mono text-player2">
                {player2.slice(0, 6)}...{player2.slice(-4)}
              </span>
            ) : (
              <span className="text-gray-500 italic">Waiting...</span>
            )}
          </div>
        </div>

        <div className="text-center py-4">
          <div className="inline-flex items-center gap-2 text-sm">
            {phase === "waiting" && (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-heist-gold opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-heist-gold" />
              </span>
            )}
            {(phase === "starting" ||
              phase === "revealing" ||
              phase === "beginning") && (
              <svg
                className="animate-spin h-4 w-4 text-heist-green"
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
            <span className="text-gray-300">
              {phaseLabels[phase] || phase}
            </span>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red break-words">
            {error}
          </div>
        )}

        {phase === "waiting" && !player2 && (
          <div className="mt-4">
            <label className="block text-xs text-gray-400 mb-2">
              Share this link with your opponent:
            </label>
            <div className="flex gap-2">
              <input
                readOnly
                value={joinUrl}
                className="flex-1 rounded-lg bg-heist-darker border border-heist-border px-3 py-2 text-sm font-mono text-gray-300"
              />
              <button
                onClick={copyLink}
                className="rounded-lg bg-heist-green/10 border border-heist-green/30 px-4 py-2 text-sm text-heist-green hover:bg-heist-green/20 transition-colors"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
