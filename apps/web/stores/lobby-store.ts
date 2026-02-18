import { create } from 'zustand';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// ─── Types ──────────────────────────────────────────────────────────────────

export type LobbyPhase =
  | 'waiting'
  | 'starting'
  | 'revealing'
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

// ─── Store state & actions ───────────────────────────────────────────────────

interface LobbyState {
  lobby: LobbyInfo | null;
  pendingAuth: PendingAuthRequest | null;
  loading: boolean;
  error: string | null;

  /** Create a new game lobby, returns gameId. */
  createLobby: (
    playerAddress: string,
    seedCommit: string,
    seedSecret: string,
  ) => Promise<string>;

  /** Join an existing lobby by gameId. */
  joinLobby: (
    gameId: string,
    playerAddress: string,
    seedCommit: string,
    seedSecret: string,
  ) => Promise<void>;

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

// Kept outside the Zustand state to avoid serialisation issues.
let _eventSource: EventSource | null = null;

// ─── Zustand store ───────────────────────────────────────────────────────────

export const useLobbyStore = create<LobbyState>((set) => ({
  lobby: null,
  pendingAuth: null,
  loading: false,
  error: null,

  createLobby: async (playerAddress, seedCommit, seedSecret) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_URL}/api/lobby`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerAddress, seedCommit, seedSecret }),
      });
      const data = await res.json() as { gameId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create lobby');
      return data.gameId!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  joinLobby: async (gameId, playerAddress, seedCommit, seedSecret) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`${API_URL}/api/lobby/${gameId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerAddress, seedCommit, seedSecret }),
      });
      const data = await res.json() as LobbyInfo & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to join lobby');
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
    // Close any existing connection before opening a new one
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
          // Extract pendingAuthRequest so use-game can react to it directly
          pendingAuth: lobby.pendingAuthRequest ?? null,
        });
      } catch (e) {
        console.error('[SSE] Failed to parse event:', e);
      }
    };

    es.onerror = () => {
      // EventSource retries automatically — log but don't set an error state
      // so the UI doesn't flash an error on transient reconnects.
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
      // Silently swallow polling errors to avoid flooding the UI
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
