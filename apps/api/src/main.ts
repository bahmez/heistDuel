import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server as SocketServer } from "socket.io";
import { projectName } from "@repo/shared";
import lobbyRouter from "./routes/lobby.js";
import { initStellar } from "./services/stellar-service.js";
import { initGameCoordinator } from "./services/game-coordinator.js";
import { registerSocketHandlers } from "./socket/handlers.js";

const port = Number(process.env.PORT ?? 3001);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ service: "api", project: projectName, status: "ok" });
});

app.use("/api/lobby", lobbyRouter);

const httpServer = createServer(app);

const io = new SocketServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

initStellar();
initGameCoordinator(io);
registerSocketHandlers(io);

httpServer.listen(port, () => {
  console.log(`Heist Duel API running on port ${port}`);
});
