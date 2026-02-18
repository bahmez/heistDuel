"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet } from "./wallet-context";
import { useSocket } from "./socket-context";
import {
  HeistContractClient,
  type PlayerGameView,
} from "@repo/stellar";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const HEIST_CONTRACT =
  process.env.NEXT_PUBLIC_HEIST_CONTRACT_ID || "";
const ZK_VERIFIER_CONTRACT =
  process.env.NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID || "";

export interface GameState {
  view: PlayerGameView | null;
  roll: number | null;
  stateHash: Uint8Array | null;
  loading: boolean;
  error: string | null;
  lobbyPhase: string | null;
  sessionId: number | null;
}

export function useGame(gameId: string) {
  const { address } = useWallet();
  const { socket } = useSocket();
  const [state, setState] = useState<GameState>({
    view: null,
    roll: null,
    stateHash: null,
    loading: false,
    error: null,
    lobbyPhase: null,
    sessionId: null,
  });
  const clientRef = useRef<HeistContractClient | null>(null);

  // Always holds the latest refreshGameState — avoids stale closures in
  // socket event handlers whose deps don't include refreshGameState.
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    clientRef.current = new HeistContractClient(HEIST_CONTRACT, RPC_URL);
  }, []);

  const refreshGameState = useCallback(async () => {
    if (!address || !clientRef.current) return;

    // Read the latest sessionId directly from the ref so we never operate on
    // a stale closure value captured at callback-creation time.
    setState((s) => {
      if (!s.sessionId) return s; // nothing to do yet
      return { ...s, loading: true, error: null };
    });

    // We need the current sessionId; pull it from state via an intermediate
    // approach — schedule the async work after the state read.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionId: number | null = (clientRef as any)._sessionId ?? null;
    if (!sessionId) return;

    try {
      const client = clientRef.current;
      const [view, roll, stateHash] = await Promise.all([
        client.getPlayerView(address, sessionId, address),
        client.getExpectedRoll(address, sessionId, address).catch(() => null),
        client.getStateHash(address, sessionId).catch(() => null),
      ]);

      const isEnded = view.status === "Ended";
      setState((s) => ({
        ...s,
        view,
        // roll is irrelevant once the game is over
        roll: isEnded ? null : roll,
        stateHash: isEnded ? null : stateHash,
        loading: false,
        error: null,
        lobbyPhase: isEnded ? "ended" : "active",
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, error: msg, loading: false }));
    }
  }, [address]);

  // Keep a stable ref so socket handlers always call the current version
  useEffect(() => {
    refreshRef.current = refreshGameState;
  }, [refreshGameState]);

  // Mirror sessionId into a ref on clientRef so refreshGameState can read it
  // without depending on state (which would create stale closures).
  const sessionIdRef = useRef<number | null>(null);
  useEffect(() => {
    sessionIdRef.current = state.sessionId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (clientRef as any)._sessionId = state.sessionId;
  }, [state.sessionId]);

  useEffect(() => {
    if (!socket || !gameId) return;
    socket.emit("join_lobby", gameId);

    const onLobbyState = (lobby: { phase: string; sessionId: number }) => {
      setState((s) => ({
        ...s,
        lobbyPhase: lobby.phase,
        sessionId: lobby.sessionId,
      }));
    };

    // Use refreshRef so we always call the latest version regardless of when
    // the effect was created.
    const onGameStarted = () => { void refreshRef.current(); };
    const onOpponentTurn = () => { void refreshRef.current(); };
    const onGameEnded = () => { void refreshRef.current(); };
    const onError = (data: { message: string }) => {
      setState((s) => ({ ...s, error: data.message }));
    };

    socket.on("lobby_state", onLobbyState);
    socket.on("game_started", onGameStarted);
    socket.on("opponent_turn", onOpponentTurn);
    socket.on("game_ended", onGameEnded);
    socket.on("error", onError);

    return () => {
      socket.off("lobby_state", onLobbyState);
      socket.off("game_started", onGameStarted);
      socket.off("opponent_turn", onOpponentTurn);
      socket.off("game_ended", onGameEnded);
      socket.off("error", onError);
    };
  }, [socket, gameId]);

  // When the lobby becomes active, start polling until we get the game view.
  // This handles RPC lag after begin_match (state may not be visible yet).
  useEffect(() => {
    if (state.lobbyPhase !== "active" || !address || !state.sessionId || state.view) return;

    // Try immediately
    void refreshRef.current();

    // Keep retrying every 5 s in case the RPC node is still catching up
    const interval = setInterval(() => {
      void refreshRef.current();
    }, 5_000);

    return () => clearInterval(interval);
    // Intentionally omit refreshRef from deps — it's a stable ref.
    // Re-run only when the key conditions change.
  }, [state.lobbyPhase, address, state.sessionId, state.view]);

  return { ...state, refreshGameState };
}
