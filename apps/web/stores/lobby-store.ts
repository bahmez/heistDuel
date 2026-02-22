import { create } from 'zustand';
import {
  generateRandomSeed,
  commitHash,
  deriveMapSeed,
} from '@repo/stellar';
import { usePrivateStore } from './private-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LobbyPhase =
  | 'waiting'
  | 'starting'
  | 'revealing'
  | 'relaying'
  | 'beginning'
  | 'active'
  | 'ended'
  | 'error';

export interface LobbyInfo {
  gameId: string;
  sessionId: number;
  player1: string;
  player2: string | null;
  phase: LobbyPhase;
  createdAt: string;
  error?: string;
  pendingAuthRequest?: PendingAuthRequest | null;
}

export interface PendingAuthRequest {
  purpose: string;
  playerAddress: string;
  preimageXdr: string;
  requestedAt: string;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

// ─── Store state & actions ───────────────────────────────────────────────────

interface LobbyState {
  lobby: LobbyInfo | null;
  pendingAuth: PendingAuthRequest | null;
  loading: boolean;
  error: string | null;

  /** Create a new game lobby, returns gameId. */
  createLobby: (playerAddress: string) => Promise<string>;

  /** Join an existing lobby by gameId. */
  joinLobby: (gameId: string, playerAddress: string) => Promise<void>;

  /**
   * Open an SSE connection to GET /api/lobby/:gameId/events.
   * The stream fires immediately with the current lobby state and then on
   * every Firestore update, so no polling is required for either lobby phase
   * or pending auth requests.
   */
  connectSSE: (gameId: string) => void;

  /** Close the active SSE connection (call on component unmount). */
  disconnectSSE: () => void;

  /**
   * One-shot REST fetch of the lobby state.
   * Used for the initial load before SSE is established, or as a fallback.
   */
  fetchLobby: (gameId: string) => Promise<void>;

  /**
   * Submit a signed auth entry to the backend.
   * The backend writes `signatureResponse` to Firestore, which is then
   * detected by its own `onSnapshot` listener to continue the game flow.
   */
  submitAuthResponse: (
    gameId: string,
    purpose: string,
    playerAddress: string,
    signatureBase64: string,
  ) => Promise<boolean>;

  clearError: () => void;
}

// ─── Module-level EventSource (singleton per tab) ───────────────────────────

let _eventSource: EventSource | null = null;

// ─── Zustand store ───────────────────────────────────────────────────────────

export const useLobbyStore = create<LobbyState>((set) => ({
  lobby: null,
  pendingAuth: null,
  loading: false,
  error: null,

  createLobby: async (playerAddress) => {
    set({ loading: true, error: null });
    try {
      // Generate dice seed and map seed secrets locally.
      const seedSecret     = generateRandomSeed();
      const seedCommit     = commitHash(seedSecret);
      const mapSeedSecret  = generateRandomSeed();
      const mapSeedCommit  = commitHash(mapSeedSecret);

      const res = await fetch(`${API_URL}/api/lobby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerAddress,
          seedCommit:    bytesToHex(seedCommit),
          seedSecret:    bytesToHex(seedSecret),
          mapSeedCommit: bytesToHex(mapSeedCommit),
          mapSeedSecret: bytesToHex(mapSeedSecret),
        }),
      });
      const data = await res.json() as { gameId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create lobby');

      // Persist own secrets in the private store.
      usePrivateStore.getState().initOwnSecrets(
        data.gameId!,
        bytesToHex(seedSecret),
        bytesToHex(mapSeedSecret),
      );

      return data.gameId!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  joinLobby: async (gameId, playerAddress) => {
    set({ loading: true, error: null });
    try {
      // Generate dice seed and map seed secrets locally.
      const seedSecret     = generateRandomSeed();
      const seedCommit     = commitHash(seedSecret);
      const mapSeedSecret  = generateRandomSeed();
      const mapSeedCommit  = commitHash(mapSeedSecret);

      const res = await fetch(`${API_URL}/api/lobby/${gameId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playerAddress,
          seedCommit:    bytesToHex(seedCommit),
          seedSecret:    bytesToHex(seedSecret),
          mapSeedCommit: bytesToHex(mapSeedCommit),
          mapSeedSecret: bytesToHex(mapSeedSecret),
        }),
      });
      const data = await res.json() as LobbyInfo & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to join lobby');

      // Persist own secrets in the private store.
      usePrivateStore.getState().initOwnSecrets(
        gameId,
        bytesToHex(seedSecret),
        bytesToHex(mapSeedSecret),
      );

      set({ lobby: data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  connectSSE: (gameId) => {
    if (_eventSource) {
      _eventSource.close();
      _eventSource = null;
    }

    const url = `${API_URL}/api/lobby/${gameId}/events`;
    const es = new EventSource(url);
    _eventSource = es;

    es.onopen = () => {
      console.log(`[SSE] Connected to lobby ${gameId}`);
    };

    es.onmessage = (event) => {
      try {
        const lobby = JSON.parse(event.data as string) as LobbyInfo;
        set({
          lobby,
          pendingAuth: lobby.pendingAuthRequest ?? null,
        });
      } catch (e) {
        console.error('[SSE] Failed to parse event:', e);
      }
    };

    es.onerror = () => {
      console.warn(`[SSE] Connection error for lobby ${gameId}, retrying...`);
    };
  },

  disconnectSSE: () => {
    if (_eventSource) {
      _eventSource.close();
      _eventSource = null;
      console.log('[SSE] Disconnected');
    }
  },

  fetchLobby: async (gameId) => {
    try {
      const res = await fetch(`${API_URL}/api/lobby/${gameId}`);
      if (!res.ok) return;
      const data = await res.json() as LobbyInfo;
      set({ lobby: data, pendingAuth: data.pendingAuthRequest ?? null });
    } catch {
      // Silently swallow polling errors
    }
  },

  submitAuthResponse: async (gameId, purpose, playerAddress, signatureBase64) => {
    try {
      const res = await fetch(`${API_URL}/api/lobby/${gameId}/auth-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, playerAddress, signatureBase64 }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));

// ─── Map secret relay helper (called from use-game.ts) ───────────────────────

/**
 * Exchange map secrets with the backend relay and persist the shared map seed.
 * Called automatically when the lobby enters the 'relaying' phase.
 *
 * Returns the derived mapSeed as hex (needed to compute commitments for begin-match).
 */
export async function performMapSecretRelay(
  gameId: string,
  playerAddress: string,
): Promise<string> {
  const priv = usePrivateStore.getState();
  if (priv.gameId !== gameId) {
    throw new Error('Private game context mismatch. Please rejoin this game link.');
  }
  if (!priv.ownMapSecret) {
    throw new Error('Map secret not initialised — create or join a lobby first');
  }

  const res = await fetch(`${API_URL}/api/lobby/${gameId}/map-secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerAddress, mapSecret: priv.ownMapSecret }),
  });

  const data = await res.json() as { opponentMapSecret?: string; error?: string };
  if (!res.ok || !data.opponentMapSecret) {
    throw new Error(data.error ?? 'Map secret relay failed');
  }

  const ownBytes      = hexToBytes(priv.ownMapSecret);
  const opponentBytes = hexToBytes(data.opponentMapSecret);
  const mapSeedBytes  = deriveMapSeed(ownBytes, opponentBytes);
  const mapSeed       = bytesToHex(mapSeedBytes);

  priv.setRelayedSecrets(data.opponentMapSecret, mapSeed);

  return mapSeed;
}
