import { create } from 'zustand';
import { HeistContractClient, type PlayerGameView } from '@repo/stellar';
import type { TurnBreakdown } from '../lib/turn-builder';
import { getRuntimeConfig } from '../lib/runtime-config';

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  'https://soroban-testnet.stellar.org';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Maximum number of turns kept in the history log. */
const MAX_TURN_HISTORY = 20;

interface GameState {
  view: PlayerGameView | null;
  roll: number | null;
  stateHash: Uint8Array | null;
  vkHash: Uint8Array | null;
  loading: boolean;
  error: string | null;

  /**
   * Chronological list of turn breakdowns submitted by the local player.
   * Used to display a score history in the UI.
   */
  turnHistory: TurnBreakdown[];

  /**
   * Fetch the current game state from the Soroban contract for a given player.
   * Populates view, roll, and stateHash.
   */
  fetchGameState: (
    playerAddress: string,
    sessionId: number,
  ) => Promise<void>;

  /**
   * Fetch the verification key hash from the ZK verifier contract.
   * Only fetched once; subsequent calls are no-ops if vkHash is already set.
   */
  fetchVkHash: (callerAddress: string) => Promise<void>;

  /** Append a turn breakdown to the history after a successful submission. */
  recordTurn: (breakdown: TurnBreakdown) => void;

  clearError: () => void;
  reset: () => void;
}

// ─── Lazy contract client (singleton per store instance) ────────────────────

let _client: HeistContractClient | null = null;
let _clientContractId = '';
async function getClient(): Promise<HeistContractClient> {
  const cfg = await getRuntimeConfig();
  if (!_client || _clientContractId !== cfg.heistContractId) {
    _client = new HeistContractClient(cfg.heistContractId, cfg.rpcUrl || RPC_URL);
    _clientContractId = cfg.heistContractId;
  }
  return _client;
}

// ─── Zustand store ───────────────────────────────────────────────────────────

export const useGameStore = create<GameState>((set, get) => ({
  view: null,
  roll: null,
  stateHash: null,
  vkHash: null,
  loading: false,
  error: null,
  turnHistory: [],

  fetchGameState: async (playerAddress, sessionId) => {
    if (!playerAddress || !sessionId) return;
    set({ loading: true, error: null });

    try {
      const client = await getClient();
      const [view, roll, stateHash] = await Promise.all([
        client.getPlayerView(playerAddress, sessionId, playerAddress),
        client.getExpectedRoll(playerAddress, sessionId, playerAddress).catch(() => null),
        client.getStateHash(playerAddress, sessionId).catch(() => null),
      ]);

      const isEnded = view.status === 'Ended';
      set({
        view,
        roll: isEnded ? null : roll,
        stateHash: isEnded ? null : stateHash,
        loading: false,
        error: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
    }
  },

  fetchVkHash: async (callerAddress) => {
    // If already fetched, skip
    if (get().vkHash) return;

    // Prefer runtime config (backend route), then env fallback.
    const cfg = await getRuntimeConfig();
    const envVkHash = cfg.vkHash || process.env.NEXT_PUBLIC_VK_HASH;
    if (envVkHash && envVkHash.length === 64) {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(envVkHash.substring(i * 2, i * 2 + 2), 16);
      }
      set({ vkHash: bytes });
      return;
    }

    if (!callerAddress || !cfg.zkVerifierContractId) return;

    try {
      const client = await getClient();
      const hash = await client.getVkHash(cfg.zkVerifierContractId, callerAddress);
      if (hash) set({ vkHash: hash });
    } catch {
      // Non-fatal — proof construction will fail later if vkHash is still null
    }
  },

  recordTurn: (breakdown) =>
    set((state) => ({
      turnHistory: [
        ...state.turnHistory.slice(-(MAX_TURN_HISTORY - 1)),
        breakdown,
      ],
    })),

  clearError: () => set({ error: null }),

  reset: () =>
    set({
      view: null,
      roll: null,
      stateHash: null,
      loading: false,
      error: null,
      turnHistory: [],
    }),
}));
