"use client";

import type { CellState } from "../lib/game-engine";

interface GameCellProps {
  cell: CellState;
  isReachable: boolean;
  isOnPath: boolean;
  isPathEnd: boolean;
  onClick: () => void;
}

export function GameCell({
  cell,
  isReachable,
  isOnPath,
  isPathEnd,
  onClick,
}: GameCellProps) {
  if (!cell.revealed) {
    return (
      <div className="aspect-square bg-fog rounded-sm border border-gray-800/30" />
    );
  }

  let bgClass = "bg-revealed";
  let content: React.ReactNode = null;
  let borderClass = "border-heist-border/30";

  if (cell.wall) {
    bgClass = "bg-wall";
    borderClass = "border-wall";
  }

  if (cell.laser) {
    bgClass += " bg-gradient-to-r from-laser/10 to-laser/20";
    borderClass = "border-laser/40";
  }

  if (isOnPath) {
    bgClass = "bg-path-highlight/30";
    borderClass = "border-path-highlight/60";
  }

  if (isReachable && !isOnPath) {
    borderClass = "border-heist-green/50 cursor-pointer";
    bgClass += " hover:bg-heist-green/10";
  }

  if (cell.hasPlayer1) {
    content = (
      <div className="absolute inset-1 rounded-full bg-player1 glow-green flex items-center justify-center text-[10px] font-bold text-white">
        P1
      </div>
    );
  } else if (cell.hasPlayer2) {
    content = (
      <div className="absolute inset-1 rounded-full bg-player2 glow-blue flex items-center justify-center text-[10px] font-bold text-white">
        P2
      </div>
    );
  } else if (cell.loot && !cell.wall) {
    content = (
      <div className="absolute inset-1 flex items-center justify-center text-loot text-base">
        &#9670;
      </div>
    );
  } else if (cell.lootCollected && !cell.wall) {
    content = (
      <div className="absolute inset-1 flex items-center justify-center text-gray-600 text-sm">
        &#9670;
      </div>
    );
  } else if (cell.camera) {
    content = (
      <div className="absolute inset-1 flex items-center justify-center text-camera text-xs">
        &#9673;
      </div>
    );
  }

  return (
    <div
      onClick={isReachable || isOnPath ? onClick : undefined}
      className={`aspect-square ${bgClass} rounded-sm border ${borderClass} relative transition-all duration-150 ${
        isReachable ? "cursor-pointer" : ""
      }`}
    >
      {content}
    </div>
  );
}
