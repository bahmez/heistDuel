"use client";

interface DiceRollProps {
  value: number | null;
  isMyTurn: boolean;
}

const DICE_FACES: Record<number, string> = {
  1: "⚀",
  2: "⚁",
  3: "⚂",
  4: "⚃",
  5: "⚄",
  6: "⚅",
};

function DieFaceBox({
  value,
  state,
}: {
  value: number;
  state: "active" | "loading" | "idle";
}) {
  const borderClass =
    state === "active"
      ? "border-heist-gold/60 shadow-[0_0_14px_rgba(245,158,11,0.2)]"
      : "border-heist-border";

  const textClass =
    state === "active"
      ? "text-heist-gold"
      : "text-gray-600";

  return (
    <div
      className={`
        w-14 h-14 rounded-xl border-2 flex items-center justify-center shrink-0
        bg-heist-darker
        ${borderClass}
        ${state === "loading" ? "animate-pulse" : ""}
      `}
    >
      <span className={`text-4xl leading-none select-none ${textClass}`}>
        {DICE_FACES[value] ?? String(value)}
      </span>
    </div>
  );
}

export function DiceRoll({ value, isMyTurn }: DiceRollProps) {
  if (!isMyTurn) {
    return (
      <div className="rounded-xl bg-heist-card border border-heist-border p-4 flex items-center gap-4 opacity-50">
        <DieFaceBox value={3} state="idle" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Dice
          </p>
          <p className="mt-1 text-sm text-gray-500">Opponent&apos;s turn</p>
        </div>
      </div>
    );
  }

  if (value === null) {
    return (
      <div className="rounded-xl bg-heist-card border border-heist-border p-4 flex items-center gap-4">
        <DieFaceBox value={1} state="loading" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Dice
          </p>
          <p className="mt-1 text-sm text-gray-400 animate-pulse">
            Loading roll…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-heist-card border border-heist-border p-4 flex items-center gap-4">
      <DieFaceBox value={value} state="active" />
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Your Roll
        </p>
        <p className="mt-1 text-3xl font-bold text-heist-gold leading-none">
          {value}
          <span className="ml-1.5 text-sm font-normal text-gray-400">
            steps
          </span>
        </p>
      </div>
    </div>
  );
}
