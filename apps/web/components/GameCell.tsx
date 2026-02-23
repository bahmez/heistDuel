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

  if (cell.isExit) {
    bgClass = "bg-heist-green/10";
    borderClass = "border-heist-green/60";
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
  } else if (cell.isExit) {
    // Exit cell: pulsing hexagon icon
    content = (
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-heist-green text-base leading-none animate-pulse select-none">
          ⬡
        </span>
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
    // Camera detects in a cross shape (+): same row or same column within radius.
    content = (
      <div className="absolute inset-0 flex items-center justify-center text-camera">
        {/* Cross indicator using two overlapping divs */}
        <div className="relative w-3 h-3">
          <div className="absolute left-1/2 top-0 -translate-x-1/2 w-[3px] h-full bg-camera/90 rounded-full" />
          <div className="absolute top-1/2 left-0 -translate-y-1/2 h-[3px] w-full bg-camera/90 rounded-full" />
        </div>
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
