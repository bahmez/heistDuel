import { create } from 'zustand';
import { BITSET_BYTES, HeistContractClient, generateMap, zeroBitset, type GameView, type PlayerGameView } from '@repo/stellar';
import type { TurnBreakdown } from '../lib/turn-builder';
import { getRuntimeConfig } from '../lib/runtime-config';
import { usePrivateStore } from './private-store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
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
   * Fetch the current game state for a given session.
   * Uses the backend API (which has admin auth) to call get_game,
   * then enriches the view with locally-tracked private data (positions, map).
   */
  fetchGameState: (
    playerAddress: string,
    sessionId: number,
    gameId: string,
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Convert whatever JSON gave us back into a real Uint8Array.
 * The backend serializes Uint8Array as a plain number array [0,255,...].
 */
function toUint8Array(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v as number[]);
  // Plain object with numeric string keys {"0":0,"1":255,...} — legacy fallback
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, number>;
    const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
    return new Uint8Array(keys.map((k) => obj[k]!));
  }
  return new Uint8Array(0);
}

/**
 * Deserialize a raw JSON GameView (all BigInts as strings, Uint8Arrays as
 * number arrays) back into a properly-typed GameView object.
 */
function deserializeGameView(raw: unknown): GameView {
  const r = raw as Record<string, unknown>;
  return {
    player1:            r.player1 as string,
    player2:            r.player2 as string,
    status:             r.status  as import('@repo/stellar').GameStatus,
    startedAtTs:        r.startedAtTs  != null ? Number(r.startedAtTs)  : null,
    deadlineTs:         r.deadlineTs   != null ? Number(r.deadlineTs)   : null,
    turnIndex:          Number(r.turnIndex),
    activePlayer:       r.activePlayer as string,
    player1Score:       BigInt(r.player1Score as string | number),
    player2Score:       BigInt(r.player2Score as string | number),
    lootTotalCollected: Number(r.lootTotalCollected),
    mapCommitment:      toUint8Array(r.mapCommitment),
    player1PosCommit:   toUint8Array(r.player1PosCommit),
    player2PosCommit:   toUint8Array(r.player2PosCommit),
    p1MapSeedCommit:    toUint8Array(r.p1MapSeedCommit),
    p2MapSeedCommit:    toUint8Array(r.p2MapSeedCommit),
    stateCommitment:    toUint8Array(r.stateCommitment),
    winner:             (r.winner as string | null) ?? null,
    lastProofId:        r.lastProofId != null ? toUint8Array(r.lastProofId) : null,
  };
}

/**
 * Build a PlayerGameView from on-chain GameView + locally-tracked private state.
 * Player positions are inferred from the private store (pos_commit tracking).
 * Since we have the full mapSeed, we regenerate the full map locally.
 */
function buildPlayerGameView(
  gameView: GameView,
  playerAddress: string,
): PlayerGameView {
  const priv = usePrivateStore.getState();

  // Determine player positions from private store.
  // The private store tracks the current player's position locally.
  // For the opponent, we only know the spawn (they don't reveal their position).
  const isPlayer1 = gameView.player1 === playerAddress;

  // Default spawn positions (mirrors use-game.ts constants)
  const P1_SPAWN = { x: 1, y: 1 };
  const P2_SPAWN = { x: 10, y: 10 };

  // My current position from private store (updated after each turn).
  const myPos = priv.posNonce
    ? { x: priv.posX, y: priv.posY }
    : (isPlayer1 ? P1_SPAWN : P2_SPAWN);

  const player1Pos = isPlayer1 ? myPos : P1_SPAWN;
  const player2Pos = isPlayer1 ? P2_SPAWN : myPos;

  // Generate full map if mapSeed is available.
  let visibleWalls  = zeroBitset();
  let visibleLoot   = zeroBitset();
  let visibleCameras: import('@repo/stellar').Camera[] = [];
  let visibleLasers:  import('@repo/stellar').Laser[]  = [];

  if (priv.mapSeed) {
    const mapSeedBytes = hexToBytes(priv.mapSeed);
    const mapData = generateMap(mapSeedBytes);
    visibleWalls   = mapData.walls;
    visibleLoot    = mapData.loot;
    visibleCameras = mapData.cameras;
    visibleLasers  = mapData.lasers;
  }

  return {
    ...gameView,
    player1Pos,
    player2Pos,
    visibleWalls,
    visibleLoot,
    visibleCameras,
    visibleLasers,
    lootCollected: priv.lootCollectedMask
      ? hexToBytes(priv.lootCollectedMask)
      : zeroBitset(),
    // bit=1 means "revealed". Reveal is progressive and stored privately.
    myFog:
      priv.myFogMask
        ? hexToBytes(priv.myFogMask)
        : new Uint8Array(BITSET_BYTES),
  };
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

  fetchGameState: async (playerAddress, sessionId, gameId) => {
    if (!playerAddress || !sessionId) return;
    set({ loading: true, error: null });

    try {
      const client = await getClient();

      // Fetch roll + state commitment from contract directly.
      const [roll, stateHash] = await Promise.all([
        client.getExpectedRoll(playerAddress, sessionId, playerAddress).catch(() => null),
        client.getStateCommitment(playerAddress, sessionId).catch(() => null),
      ]);

      // Fetch game view via backend (admin auth required for get_game).
      let gameView: GameView | null = null;
      if (gameId) {
        try {
          const res = await fetch(`${API_URL}/api/lobby/${gameId}/game-state`);
          if (res.ok) {
            gameView = deserializeGameView(await res.json());
          }
        } catch {
          // Non-fatal: fall through to null view
        }
      }

      if (gameView) {
        const view = buildPlayerGameView(gameView, playerAddress);
        const isEnded = view.status === 'Ended';
        set({
          view,
          roll: isEnded ? null : roll,
          stateHash: isEnded ? null : stateHash,
          loading: false,
          error: null,
        });
      } else {
        set({ loading: false, error: 'Failed to fetch game state from backend' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
    }
  },

  fetchVkHash: async (callerAddress) => {
    if (get().vkHash) return;

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
      // Non-fatal
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
