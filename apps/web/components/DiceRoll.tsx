"use client";

interface DiceRollProps {
  value: number | null;
  isMyTurn: boolean;
}

const diceFaces: Record<number, string> = {
  1: "\u2680",
  2: "\u2681",
  3: "\u2682",
  4: "\u2683",
  5: "\u2684",
  6: "\u2685",
};

export function DiceRoll({ value, isMyTurn }: DiceRollProps) {
  if (!isMyTurn) {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <span className="text-3xl opacity-40">{diceFaces[3]}</span>
        <span className="text-sm">Opponent&apos;s turn</span>
      </div>
    );
  }

  if (value === null) {
    return (
      <div className="flex items-center gap-2 text-gray-400">
        <span className="text-3xl animate-pulse">{diceFaces[1]}</span>
        <span className="text-sm">Loading roll...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-5xl text-heist-gold glow-gold">
        {diceFaces[value] || value}
      </span>
      <div>
        <div className="text-sm text-gray-400">Your roll</div>
        <div className="text-2xl font-bold text-heist-gold">{value} steps</div>
      </div>
    </div>
  );
}
