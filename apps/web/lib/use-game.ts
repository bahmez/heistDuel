"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  computePosCommit,
  deriveInitialPosNonce,
  generateMap,
  computeMapCommitment,
} from "@repo/stellar";
import { useGameStore } from "../stores/game-store";
import { useLobbyStore, performMapSecretRelay } from "../stores/lobby-store";
import { usePrivateStore } from "../stores/private-store";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

const GAME_POLL_INTERVAL_MS = 5_000;

// Initial spawn positions (mirrors engine.rs constants)
const P1_SPAWN = { x: 1, y: 1 };
const P2_SPAWN = { x: 10, y: 10 };

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Game state hook — wires together the SSE lobby stream, auth-entry signing,
 * on-chain game state polling, and the ZK setup phases (relaying / beginning).
 *
 * Responsibilities:
 *  1. Open an SSE connection to GET /api/lobby/:gameId/events on mount.
 *  2. Auto-sign pending auth-entry requests when they appear in the SSE stream.
 *  3. When phase === 'relaying': exchange map secrets via the backend relay,
 *     compute commitments, and trigger begin-match.
 *  4. Poll on-chain game state every 5 s once the lobby is active.
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

  const { view, roll, stateHash, vkHash, loading, error, fetchGameState, fetchVkHash, recordTurn } =
    useGameStore();

  const priv = usePrivateStore();

  // Track which auth requests we've already submitted to avoid double-signing.
  const submittedAuthKeys = useRef<Set<string>>(new Set());

  // Guard against running the relay/begin-match flow twice per session.
  const relayDone = useRef(false);

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
        submittedAuthKeys.current.delete(key);
      }
    })();
  }, [pendingAuth, playerAddress, signAuthEntry, gameId, submitAuthResponse]);

  // ─── ZK relay + begin-match flow ────────────────────────────────────────────
  //
  // Triggered when the lobby enters the 'relaying' phase.
  // Also runs as a recovery if the game is already 'active' but mapSeed is lost
  // (e.g. after a page refresh before the persist middleware was added).
  // Each player independently:
  //   1. Calls POST /lobby/:gameId/map-secret → receives opponent's map secret
  //   2. Derives mapSeed = keccak(ownSecret XOR opponentSecret)
  //   3. Generates posNonce, computes posCommit and mapCommitment
  //   4. Calls POST /lobby/:gameId/begin-match with the commitments
  //   5. Stores sessionSeed and posNonce in the private store

  useEffect(() => {
    const phase = lobby?.phase;
    const needsRelay = phase === "relaying";
    // Recovery: game is active but mapSeed was lost (page refresh before persist was added)
    const needsRecovery = phase === "active" && !priv.mapSeed && priv.ownMapSecret;
    if (!needsRelay && !needsRecovery) return;
    if (!playerAddress) return;
    if (relayDone.current) return;

    relayDone.current = true;

    void (async () => {
      try {
        const phase = lobby?.phase;
        const isRecovery = phase === "active";

        console.log(`[relay] ${isRecovery ? "Recovering" : "Starting"} map secret relay...`);

        // Step 1: Exchange secrets with the backend relay.
        const mapSeedHex = await performMapSecretRelay(gameId, playerAddress);
        const mapSeed    = hexToBytes(mapSeedHex);

        // Derive position nonces.
        const p1InitialNonce = deriveInitialPosNonce(mapSeed, 1);
        const p2InitialNonce = deriveInitialPosNonce(mapSeed, 2);
        const isPlayer1 = lobby!.player1 === playerAddress;
        const myInitialNonce = isPlayer1 ? p1InitialNonce : p2InitialNonce;

        if (isRecovery) {
          // Recovery path: game already active, mapSeed was lost after page refresh.
          // performMapSecretRelay already called setRelayedSecrets (mapSeed is now set).
          // Restore posNonce + sessionSeed if also missing.
          const currentPriv = usePrivateStore.getState();
          if (!currentPriv.posNonce) {
            const mySpawn = isPlayer1 ? P1_SPAWN : P2_SPAWN;
            if (currentPriv.sessionSeed) {
              // sessionSeed persisted — only posNonce needs restoring.
              priv.initGameSecrets(currentPriv.sessionSeed, bytesToHex(myInitialNonce), mySpawn.x, mySpawn.y);
            } else {
              // sessionSeed lost too — fetch it via idempotent begin-match call.
              const mapData       = generateMap(mapSeed);
              const mapCommitment = computeMapCommitment(mapData);
              const p1PosCommit   = computePosCommit(P1_SPAWN.x, P1_SPAWN.y, p1InitialNonce);
              const p2PosCommit   = computePosCommit(P2_SPAWN.x, P2_SPAWN.y, p2InitialNonce);
              const res = await fetch(`${API_URL}/api/lobby/${gameId}/begin-match`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  mapCommitment: bytesToHex(mapCommitment),
                  p1PosCommit:   bytesToHex(p1PosCommit),
                  p2PosCommit:   bytesToHex(p2PosCommit),
                }),
              });
              const data = await res.json() as { ok?: boolean; sessionSeed?: string; error?: string };
              if (res.ok && data.sessionSeed) {
                priv.initGameSecrets(data.sessionSeed, bytesToHex(myInitialNonce), mySpawn.x, mySpawn.y);
              }
            }
          }
          console.log("[relay] Recovery complete. MapSeed restored.");
          return;
        }

        // Normal relay path (phase === 'relaying').

        // Step 2: Derive map data and commitment.
        const mapData       = generateMap(mapSeed);
        const mapCommitment = computeMapCommitment(mapData);

        // Step 3: Compute initial position commitments for both players.
        const p1PosCommit = computePosCommit(P1_SPAWN.x, P1_SPAWN.y, p1InitialNonce);
        const p2PosCommit = computePosCommit(P2_SPAWN.x, P2_SPAWN.y, p2InitialNonce);

        console.log("[relay] Computed commitments, calling begin-match...");

        // Step 4: Call begin-match on the backend (triggers the on-chain tx).
        const res = await fetch(`${API_URL}/api/lobby/${gameId}/begin-match`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mapCommitment: bytesToHex(mapCommitment),
            p1PosCommit:   bytesToHex(p1PosCommit),
            p2PosCommit:   bytesToHex(p2PosCommit),
          }),
        });

        const data = await res.json() as { ok?: boolean; sessionSeed?: string; error?: string };
        if (!res.ok || !data.sessionSeed) {
          throw new Error(data.error ?? "begin-match failed or sessionSeed missing");
        }

        // Step 5: Persist session seed, our initial position nonce, and spawn.
        const mySpawn = isPlayer1 ? P1_SPAWN : P2_SPAWN;
        priv.initGameSecrets(
          data.sessionSeed,
          bytesToHex(myInitialNonce),
          mySpawn.x,
          mySpawn.y,
        );

        console.log("[relay] ZK setup complete. Session seed stored.");
      } catch (err) {
        console.error("[relay] ZK setup failed:", err);
        relayDone.current = false; // allow retry on next SSE update
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby?.phase, playerAddress, gameId, priv.mapSeed]);

  // ─── Game state polling (active phase) ─────────────────────────────────────

  const sessionId = lobby?.sessionId;

  const refreshGameState = useCallback(async () => {
    if (!playerAddress || !sessionId) return;
    await fetchGameState(playerAddress, sessionId, gameId);
  }, [playerAddress, sessionId, gameId, fetchGameState]);

  useEffect(() => {
    if (lobby?.phase !== "active" || !playerAddress || !sessionId) return;

    void refreshGameState();

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
    recordTurn,
    lobbyPhase: lobby?.phase ?? null,
    sessionId:  lobby?.sessionId ?? null,
    refreshGameState,
  };
}
