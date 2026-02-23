"use client";

import { useMemo } from "react";
import { GameCell } from "./GameCell";
import type { PlayerGameView, Position } from "@repo/stellar";
import { buildGrid, getReachableCells } from "../lib/game-engine";
import { MAP_W, MAP_H } from "@repo/stellar";

interface GameBoardProps {
  view: PlayerGameView;
  playerAddress: string;
  roll: number | null;
  selectedPath: Position[];
  onCellClick: (x: number, y: number) => void;
  isMyTurn: boolean;
}

export function GameBoard({
  view,
  playerAddress,
  roll,
  selectedPath,
  onCellClick,
  isMyTurn,
}: GameBoardProps) {
  const grid = useMemo(() => buildGrid(view, playerAddress), [view, playerAddress]);

  const reachableCells = useMemo(() => {
    if (!isMyTurn || !roll) return new Set<string>();
    const positions = getReachableCells(view, playerAddress, roll);
    return new Set(positions.map((p) => `${p.x},${p.y}`));
  }, [view, playerAddress, roll, isMyTurn]);

  const pathSet = useMemo(
    () => new Set(selectedPath.map((p) => `${p.x},${p.y}`)),
    [selectedPath],
  );

  const pathEnd =
    selectedPath.length > 0
      ? selectedPath[selectedPath.length - 1]
      : null;

  return (
    <div className="inline-block rounded-xl bg-heist-darker border border-heist-border p-3">
      <div
        className="grid gap-[2px]"
        style={{
          gridTemplateColumns: `repeat(${MAP_W}, minmax(0, 1fr))`,
          width: `${MAP_W * 36}px`,
        }}
      >
        {grid.flatMap((row, y) =>
          row.map((cell, x) => (
            <GameCell
              key={`${x}-${y}`}
              cell={cell}
              isReachable={isMyTurn && reachableCells.has(`${x},${y}`)}
              isOnPath={pathSet.has(`${x},${y}`)}
              isPathEnd={pathEnd?.x === x && pathEnd?.y === y}
              onClick={() => onCellClick(x, y)}
            />
          )),
        )}
      </div>

      <div className="flex gap-4 mt-3 text-xs text-gray-400 justify-center flex-wrap">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-player1 inline-block" /> P1
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-player2 inline-block" /> P2
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-wall inline-block" /> Wall
        </span>
        <span className="flex items-center gap-1">
          <span className="text-loot">&#9670;</span> Loot
        </span>
        <span className="flex items-center gap-1">
          {/* Camera detects in a cross (+): same row or column within radius */}
          <span className="relative inline-block w-3 h-3">
            <span className="absolute left-1/2 top-0 -translate-x-1/2 w-[3px] h-full bg-camera/80 rounded-full" />
            <span className="absolute top-1/2 left-0 -translate-y-1/2 h-[3px] w-full bg-camera/80 rounded-full" />
          </span>
          Camera (✛)
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-[2px] bg-laser inline-block" /> Laser
        </span>
        <span className="flex items-center gap-1">
          <span className="text-heist-green text-base leading-none">⬡</span> Exit
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-fog inline-block border border-gray-700" /> Fog
        </span>
      </div>
    </div>
  );
}
