"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WalletButton } from "../components/WalletButton";
import { useWallet } from "../lib/wallet-context";
import { useLobbyStore } from "../stores/lobby-store";

// ─── Legend item ──────────────────────────────────────────────────────────────

function LegendItem({
  icon,
  label,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-6 h-6 flex items-center justify-center shrink-0 mt-0.5">
        {icon}
      </div>
      <div>
        <span className="text-sm text-gray-300">{label}</span>
        {sub && <span className="ml-1.5 text-xs text-gray-500">{sub}</span>}
      </div>
    </div>
  );
}

// ─── Rule step ────────────────────────────────────────────────────────────────

function RuleStep({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="w-6 h-6 rounded-full bg-heist-green/20 border border-heist-green/40 text-heist-green text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
        {n}
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-200">{title}</p>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{children}</p>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

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

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-2xl w-full space-y-8">

          {/* ── Hero ── */}
          <div className="text-center space-y-3">
            <h2 className="text-4xl font-bold text-white">
              <span className="text-heist-green">ZK</span> Heist Game
            </h2>
            <p className="text-gray-400 max-w-lg mx-auto">
              A turn-based stealth game on Stellar. Navigate a 12×12 grid,
              collect loot, avoid cameras and lasers — then escape through the
              exit. Every move is verified on-chain with zero-knowledge proofs.
            </p>
          </div>

          {/* ── Create / Join ── */}
          {!connected ? (
            <div className="text-center">
              <p className="text-gray-500 mb-4">Connect your wallet to start playing</p>
              <WalletButton />
            </div>
          ) : (
            <div className="max-w-lg mx-auto space-y-4">
              <button
                onClick={handleCreateGame}
                disabled={loading}
                className="w-full rounded-xl bg-heist-green/10 border-2 border-heist-green/30 px-6 py-4 text-lg font-semibold text-heist-green hover:bg-heist-green/20 hover:border-heist-green/50 disabled:opacity-50 transition-all glow-green"
              >
                {loading ? "Creating..." : "Create New Game"}
              </button>

              <div className="flex items-center gap-4">
                <div className="flex-1 h-px bg-heist-border" />
                <span className="text-xs text-gray-500 uppercase">or join</span>
                <div className="flex-1 h-px bg-heist-border" />
              </div>

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

          {/* ── Rules + Legend ── */}
          <div className="grid md:grid-cols-2 gap-6">

            {/* How to Play */}
            <div className="rounded-xl bg-heist-card border border-heist-border p-6 space-y-5">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                How to Play
              </h3>

              <div className="space-y-4">
                <RuleStep n={1} title="Objective">
                  Collect as much loot as possible, then reach the{" "}
                  <span className="text-heist-green font-medium">exit ⬡</span> to
                  escape. The player with the highest score when both have exited
                  — or when time runs out — wins.
                </RuleStep>

                <RuleStep n={2} title="Your turn">
                  A dice (1–6) is rolled automatically. Move your character
                  exactly that many steps through revealed cells. You can only
                  move through cells you have already explored.
                </RuleStep>

                <RuleStep n={3} title="Collect &amp; avoid">
                  Step on a <span className="text-loot font-medium">loot ◆</span> cell
                  to earn <span className="text-heist-green font-medium">+1 pt</span>.
                  Entering a camera detection zone costs{" "}
                  <span className="text-heist-red font-medium">−1 pt</span> and
                  crossing a laser costs{" "}
                  <span className="text-heist-red font-medium">−2 pts</span>.
                </RuleStep>

                <RuleStep n={4} title="Fog of war &amp; ZK proofs">
                  You only see cells you have visited. Your exact position is
                  hidden from your opponent and proven correct on-chain with a
                  zero-knowledge proof — no cheating possible.
                </RuleStep>

                <RuleStep n={5} title="Chess clock — 5 min each">
                  Each player has 5 minutes total across all their turns. The
                  clock only ticks on your turn. Run out of time and you lose.
                </RuleStep>
              </div>

              <p className="text-xs text-gray-600 border-t border-heist-border pt-3">
                Running on Stellar Testnet — no real funds required.
              </p>
            </div>

            {/* Legend */}
            <div className="rounded-xl bg-heist-card border border-heist-border p-6 space-y-5">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">
                Legend
              </h3>

              <div className="space-y-3">
                {/* Exit */}
                <LegendItem
                  icon={
                    <span className="text-heist-green text-lg leading-none animate-pulse">
                      ⬡
                    </span>
                  }
                  label="Exit"
                  sub="— reach it to escape"
                />

                {/* Player 1 */}
                <LegendItem
                  icon={
                    <div className="w-5 h-5 rounded-full bg-player1 flex items-center justify-center">
                      <span className="text-[9px] font-bold text-white">P1</span>
                    </div>
                  }
                  label="Player 1"
                />

                {/* Player 2 */}
                <LegendItem
                  icon={
                    <div className="w-5 h-5 rounded-full bg-player2 flex items-center justify-center">
                      <span className="text-[9px] font-bold text-white">P2</span>
                    </div>
                  }
                  label="Player 2"
                />

                {/* Loot */}
                <LegendItem
                  icon={<span className="text-loot text-base">&#9670;</span>}
                  label="Loot"
                  sub="— +1 pt when collected"
                />

                {/* Camera */}
                <LegendItem
                  icon={
                    <div className="relative w-4 h-4">
                      <div className="absolute left-1/2 top-0 -translate-x-1/2 w-[2px] h-full bg-camera/90 rounded-full" />
                      <div className="absolute top-1/2 left-0 -translate-y-1/2 h-[2px] w-full bg-camera/90 rounded-full" />
                    </div>
                  }
                  label="Security camera"
                  sub="— entering its zone costs −1 pt"
                />

                {/* Camera zone */}
                <LegendItem
                  icon={
                    <div className="w-5 h-5 rounded-sm bg-heist-red/20 border border-heist-red/40" />
                  }
                  label="Camera detection zone"
                  sub="— highlighted in red"
                />

                {/* Laser */}
                <LegendItem
                  icon={
                    <div className="w-5 h-[3px] bg-laser rounded-full self-center" />
                  }
                  label="Laser beam"
                  sub="— crossing costs −2 pts"
                />

                {/* Wall */}
                <LegendItem
                  icon={
                    <div className="w-5 h-5 rounded-sm bg-wall border border-gray-600" />
                  }
                  label="Wall"
                  sub="— impassable"
                />

                {/* Fog */}
                <LegendItem
                  icon={
                    <div className="w-5 h-5 rounded-sm bg-fog border border-gray-800" />
                  }
                  label="Fog"
                  sub="— unexplored area"
                />
              </div>
            </div>

          </div>
        </div>
      </div>
    </main>
  );
}
