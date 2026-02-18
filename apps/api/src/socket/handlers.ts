import type { Server as SocketServer, Socket } from "socket.io";
import { getLobby } from "../services/lobby-store.js";
import { initiateStartGame } from "../services/game-coordinator.js";

export function registerSocketHandlers(io: SocketServer): void {
  io.on("connection", (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("join_lobby", (gameId: string) => {
      socket.join(`game:${gameId}`);
      const lobby = getLobby(gameId);
      if (lobby) {
        socket.emit("lobby_state", lobby);
      }
    });

    socket.on("player_ready", async (data: { gameId: string }) => {
      try {
        const lobby = getLobby(data.gameId);
        if (!lobby) {
          socket.emit("error", { message: "Game not found" });
          return;
        }

        if (lobby.player2 && lobby.phase === "waiting") {
          await initiateStartGame(io, data.gameId);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("player_ready error:", msg);
        socket.emit("error", { message: msg });
      }
    });

    socket.on(
      "turn_submitted",
      (data: { gameId: string; playerAddress: string }) => {
        io.to(`game:${data.gameId}`).emit("opponent_turn", {
          playerAddress: data.playerAddress,
        });
      },
    );

    socket.on(
      "game_ended",
      (data: { gameId: string; winner: string }) => {
        io.to(`game:${data.gameId}`).emit("game_ended", {
          winner: data.winner,
        });
      },
    );

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}
