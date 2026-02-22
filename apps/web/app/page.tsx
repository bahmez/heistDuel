"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WalletButton } from "../components/WalletButton";
import { useWallet } from "../lib/wallet-context";
import { useLobbyStore } from "../stores/lobby-store";

export default function HomePage() {
  const router = useRouter();
  const { address, connected } = useWallet();
  const { createLobby, joinLobby, loading, error, clearError } = useLobbyStore();
  const [joinCode, setJoinCode] = useState("");

  const handleCreateGame = async () => {
    if (!address) return;
    clearError();

    try {
      const gameId = await createLobby(address);

      router.push(`/game/${gameId}`);
    } catch {
      // Error already stored in the lobby store
    }
  };

  const handleJoinGame = async () => {
    if (!address || !joinCode.trim()) return;
    clearError();

    try {
      const gameId = joinCode.trim();

      await joinLobby(gameId, address);

      router.push(`/game/${gameId}`);
    } catch {
      // Error already stored in the lobby store
    }
  };

  return (
    <main className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-heist-border">
        <h1 className="text-xl font-bold text-white">
          <span className="text-heist-green">Heist</span> Duel
        </h1>
        <WalletButton />
      </header>

      {/* Hero */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-lg w-full space-y-8">
          <div className="text-center space-y-3">
            <h2 className="text-4xl font-bold text-white">
              <span className="text-heist-green">ZK</span> Heist Game
            </h2>
            <p className="text-gray-400">
              A turn-based stealth game on Stellar. Navigate the grid, collect
              loot, avoid cameras and lasers. Every move is verified on-chain
              with zero-knowledge proofs.
            </p>
          </div>

          {!connected ? (
            <div className="text-center">
              <p className="text-gray-500 mb-4">
                Connect your wallet to start playing
              </p>
              <WalletButton />
            </div>
          ) : (
            <div className="space-y-4">
              {/* Create Game */}
              <button
                onClick={handleCreateGame}
                disabled={loading}
                className="w-full rounded-xl bg-heist-green/10 border-2 border-heist-green/30 px-6 py-4 text-lg font-semibold text-heist-green hover:bg-heist-green/20 hover:border-heist-green/50 disabled:opacity-50 transition-all glow-green"
              >
                {loading ? "Creating..." : "Create New Game"}
              </button>

              {/* Divider */}
              <div className="flex items-center gap-4">
                <div className="flex-1 h-px bg-heist-border" />
                <span className="text-xs text-gray-500 uppercase">or join</span>
                <div className="flex-1 h-px bg-heist-border" />
              </div>

              {/* Join Game */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="Enter game code"
                  className="flex-1 rounded-xl bg-heist-card border border-heist-border px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-heist-blue transition-colors"
                />
                <button
                  onClick={handleJoinGame}
                  disabled={loading || !joinCode.trim()}
                  className="rounded-xl bg-heist-blue/10 border border-heist-blue/30 px-6 py-3 font-semibold text-heist-blue hover:bg-heist-blue/20 disabled:opacity-50 transition-all"
                >
                  {loading ? "Joining..." : "Join"}
                </button>
              </div>

              {error && (
                <div className="rounded-lg bg-heist-red/10 border border-heist-red/30 p-3 text-sm text-heist-red">
                  {error}
                </div>
              )}
            </div>
          )}

          {/* Game Rules */}
          <div className="rounded-xl bg-heist-card border border-heist-border p-6 space-y-4">
            <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
              How to Play
            </h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex gap-2">
                <span className="text-heist-gold">&#9670;</span>
                <span className="text-gray-300">Collect loot to score points</span>
              </div>
              <div className="flex gap-2">
                <span className="text-camera">&#9673;</span>
                <span className="text-gray-300">Cameras deduct 1 point</span>
              </div>
              <div className="flex gap-2">
                <span className="text-laser">&#9473;</span>
                <span className="text-gray-300">Lasers deduct 2 points</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500">&#9632;</span>
                <span className="text-gray-300">Fog hides unexplored areas</span>
              </div>
            </div>
            <p className="text-xs text-gray-500">
              12x12 grid. 5 minutes per game. Highest score wins. Testnet only.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
