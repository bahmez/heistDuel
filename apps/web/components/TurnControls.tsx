"use client";

import type { Position } from "@repo/stellar";

interface TurnControlsProps {
  isMyTurn: boolean;
  selectedPath: Position[];
  roll: number | null;
  onSubmit: () => void;
  onSkip: () => void;
  onClear: () => void;
  submitting: boolean;
  canSkip: boolean;
}

export function TurnControls({
  isMyTurn,
  selectedPath,
  roll,
  onSubmit,
  onSkip,
  onClear,
  submitting,
  canSkip,
}: TurnControlsProps) {
  if (!isMyTurn) {
    return (
      <div className="rounded-xl bg-heist-card border border-heist-border p-4 text-center">
        <p className="text-gray-400">Waiting for opponent&apos;s move...</p>
      </div>
    );
  }

  // With partial-move rules the player may stop after 1..=roll steps.
  // A path is valid as soon as at least 1 step has been selected.
  const stepsSelected = selectedPath.length > 0 ? selectedPath.length - 1 : 0;
  const pathComplete = roll !== null && stepsSelected >= 1 && stepsSelected <= roll;

  return (
    <div className="rounded-xl bg-heist-card border border-heist-border p-4 space-y-3">
      <div className="text-sm text-gray-400">
        {!pathComplete ? (
          <>
            Click a highlighted cell to move.{" "}
            <span className="text-heist-green font-mono">
              {stepsSelected}/{roll || 0}
            </span>{" "}
            steps selected.
          </>
        ) : (
          <span className="text-heist-green">
            {stepsSelected}/{roll} steps — ready to submit!
          </span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!pathComplete || submitting}
          className="flex-1 rounded-lg bg-heist-green/20 border border-heist-green/40 px-4 py-2.5 text-sm font-semibold text-heist-green hover:bg-heist-green/30 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
        >
          {submitting ? "Submitting..." : "Submit Turn"}
        </button>

        {canSkip && (
          <button
            onClick={onSkip}
            disabled={submitting}
            className="rounded-lg bg-heist-gold/10 border border-heist-gold/30 px-4 py-2.5 text-sm text-heist-gold hover:bg-heist-gold/20 disabled:opacity-30 transition-all"
          >
            Skip
          </button>
        )}

        {selectedPath.length > 1 && (
          <button
            onClick={onClear}
            className="rounded-lg bg-heist-card border border-heist-border px-4 py-2.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
