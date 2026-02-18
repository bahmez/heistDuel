"use client";

import { useEffect, useRef, useCallback } from "react";
import { useGameStore } from "../stores/game-store";
import { useLobbyStore } from "../stores/lobby-store";

const GAME_POLL_INTERVAL_MS = 5_000;

/**
 * Game state hook — wires together the SSE lobby stream, auth-entry signing,
 * and on-chain game state polling.
 *
 * Responsibilities:
 *  1. Open an SSE connection to GET /api/lobby/:gameId/events on mount.
 *     The stream delivers real-time lobby state + pending auth requests —
 *     no polling required for either.
 *  2. Auto-sign pending auth-entry requests when they appear in the SSE stream.
 *  3. Poll on-chain game state every 5 s once the lobby is active.
 */
export function useGame(
  gameId: string,
  playerAddress: string | undefined,
  signAuthEntry: ((preimageXdr: string) => Promise<string>) | undefined,
) {
  const {
    lobby,
    pendingAuth,
    connectSSE,
    disconnectSSE,
    submitAuthResponse,
  } = useLobbyStore();

  const { view, roll, stateHash, vkHash, loading, error, fetchGameState, fetchVkHash } =
    useGameStore();

  // Track which auth requests we've already submitted to avoid double-signing
  const submittedAuthKeys = useRef<Set<string>>(new Set());

  // ─── SSE connection ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!gameId) return;
    connectSSE(gameId);
    return () => disconnectSSE();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  // ─── Auto-sign pending auth entries ─────────────────────────────────────────

  useEffect(() => {
    if (!pendingAuth || !playerAddress || !signAuthEntry) return;
    if (pendingAuth.playerAddress !== playerAddress) return;

    // Deduplicate: only sign each request once (purpose + timestamp = unique key)
    const key = `${pendingAuth.purpose}:${pendingAuth.requestedAt}`;
    if (submittedAuthKeys.current.has(key)) return;
    submittedAuthKeys.current.add(key);

    void (async () => {
      try {
        console.log(`[auth] Signing entry for: ${pendingAuth.purpose}`);
        const signatureBase64 = await signAuthEntry(pendingAuth.preimageXdr);
        const ok = await submitAuthResponse(
          gameId,
          pendingAuth.purpose,
          playerAddress,
          signatureBase64,
        );
        if (!ok) {
          console.error("[auth] submitAuthResponse returned false");
          submittedAuthKeys.current.delete(key);
        }
      } catch (err) {
        console.error("[auth] Failed to sign auth entry:", err);
        // Remove from submitted set so the user can retry on the next SSE event
        submittedAuthKeys.current.delete(key);
      }
    })();
  }, [pendingAuth, playerAddress, signAuthEntry, gameId, submitAuthResponse]);

  // ─── Game state polling (active phase) ─────────────────────────────────────

  const sessionId = lobby?.sessionId;

  const refreshGameState = useCallback(async () => {
    if (!playerAddress || !sessionId) return;
    await fetchGameState(playerAddress, sessionId);
  }, [playerAddress, sessionId, fetchGameState]);

  useEffect(() => {
    if (lobby?.phase !== "active" || !playerAddress || !sessionId) return;

    // Fetch immediately when phase transitions to active
    void refreshGameState();

    // Keep polling to pick up opponent turns and game-over status
    const id = setInterval(() => void refreshGameState(), GAME_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [lobby?.phase, playerAddress, sessionId, refreshGameState]);

  // ─── VK hash fetch ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (playerAddress) {
      void fetchVkHash(playerAddress);
    }
  }, [playerAddress, fetchVkHash]);

  return {
    view,
    roll,
    stateHash,
    vkHash,
    loading,
    error,
    lobbyPhase: lobby?.phase ?? null,
    sessionId: lobby?.sessionId ?? null,
    refreshGameState,
  };
}
