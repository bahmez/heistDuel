/**
 * ZK Private Game State Store
 *
 * Holds cryptographic secrets that must never leave the browser:
 *   - Map seed secrets (own + opponent's, exchanged via the backend relay)
 *   - Session seed (keccak(p1_dice_seed || p2_dice_seed), returned by /begin-match)
 *   - Position nonce (private commitment nonce, advanced after each turn)
 *   - Own dice seed secret (generated at create/join)
 *
 * All values are stored as lowercase hex strings.
 * This store is NEVER sent to any server as a whole — individual fields are
 * extracted and sent to the proof endpoint when a turn is submitted.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { BITSET_BYTES, MAP_H, MAP_W, bitSet } from '@repo/stellar';

// ─── State shape ─────────────────────────────────────────────────────────────

interface PrivateGameState {
  /** Current game context for these secrets. */
  gameId: string | null;

  /** My dice seed secret (hex 32 bytes). Generated at create/join. */
  ownSeedSecret: string | null;

  /** My map seed secret (hex 32 bytes). Generated at create/join. */
  ownMapSecret: string | null;

  /** Opponent's map secret (hex 32 bytes). Received via /map-secret relay. */
  opponentMapSecret: string | null;

  /** Derived map seed = keccak(ownMapSecret XOR opponentMapSecret) (hex 32 bytes). */
  mapSeed: string | null;

  /**
   * Session seed = keccak(p1_dice_seed || p2_dice_seed) (hex 32 bytes).
   * Returned by the backend after begin_match succeeds.
   * Needed for deterministic dice roll verification inside the ZK circuit.
   */
  sessionSeed: string | null;

  /**
   * Private position nonce (hex 32 bytes).
   * Derived from mapSeed at game start, then replaced with a fresh random
   * nonce after every submitted turn.
   * pos_commit = keccak(pos_x || pos_y || pos_nonce)
   */
  posNonce: string | null;

  /** Current player position (tracked locally after each turn). */
  posX: number;
  posY: number;

  /**
   * Fog visibility mask (hex bitset).
   * bit=1 means "revealed".
   */
  myFogMask: string | null;

  /**
   * Loot collected mask (hex bitset).
   * bit=1 means "loot at this cell has been collected by me".
   * Accumulated across turns so the map shows collected loot grayed-out.
   */
  lootCollectedMask: string | null;

  // ─── Actions ───────────────────────────────────────────────────────────────

  /** Called at lobby create/join. Stores the player's own secrets. */
  initOwnSecrets: (gameId: string, seedSecret: string, mapSecret: string) => void;

  /** Called after the backend relays the opponent's map secret. */
  setRelayedSecrets: (opponentMapSecret: string, mapSeed: string) => void;

  /** Called after begin_match succeeds. Stores sessionSeed, posNonce, and spawn position. */
  initGameSecrets: (sessionSeed: string, posNonce: string, x?: number, y?: number) => void;

  /**
   * Called after a turn is successfully submitted on-chain.
   * Advances nonce, position, fog, and accumulates the loot collected during the turn.
   * @param lootDelta - bitset of cells where loot was just picked up (may be empty)
   */
  advancePosNonce: (newNonce: string, newX: number, newY: number, lootDelta?: Uint8Array) => void;

  /** Reset all secrets (on game end or page unload). */
  reset: () => void;
}

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

function revealAround(mask: Uint8Array, x: number, y: number): Uint8Array {
  const next = new Uint8Array(mask);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      bitSet(next, ny * MAP_W + nx);
    }
  }
  return next;
}

// ─── Zustand store ───────────────────────────────────────────────────────────

export const usePrivateStore = create<PrivateGameState>()(
  persist(
    (set) => ({
      gameId:             null,
      ownSeedSecret:      null,
      ownMapSecret:       null,
      opponentMapSecret:  null,
      mapSeed:            null,
      sessionSeed:        null,
      posNonce:           null,
      posX:               1,  // P1 spawn default; overwritten at initGameSecrets
      posY:               1,
      myFogMask:          null,
      lootCollectedMask:  null,

      initOwnSecrets: (gameId, seedSecret, mapSecret) =>
        set((state) => {
          const changedGame = state.gameId !== gameId;
          return {
            gameId,
            ownSeedSecret: seedSecret,
            ownMapSecret: mapSecret,
            // Reset game-specific derived secrets if this is a different game.
            opponentMapSecret:  changedGame ? null : state.opponentMapSecret,
            mapSeed:            changedGame ? null : state.mapSeed,
            sessionSeed:        changedGame ? null : state.sessionSeed,
            posNonce:           changedGame ? null : state.posNonce,
            posX:               changedGame ? 1 : state.posX,
            posY:               changedGame ? 1 : state.posY,
            myFogMask:          changedGame ? null : state.myFogMask,
            lootCollectedMask:  changedGame ? null : state.lootCollectedMask,
          };
        }),

      setRelayedSecrets: (opponentMapSecret, mapSeed) =>
        set({ opponentMapSecret, mapSeed }),

      initGameSecrets: (sessionSeed, posNonce, x = 1, y = 1) =>
        set((state) => {
          const start = state.myFogMask
            ? hexToBytes(state.myFogMask)
            : new Uint8Array(BITSET_BYTES);
          const revealed = revealAround(start, x, y);
          return {
            sessionSeed,
            posNonce,
            posX: x,
            posY: y,
            myFogMask: bytesToHex(revealed),
          };
        }),

      advancePosNonce: (newNonce, newX, newY, lootDelta) =>
        set((state) => {
          const fogStart = state.myFogMask
            ? hexToBytes(state.myFogMask)
            : new Uint8Array(BITSET_BYTES);
          const revealed = revealAround(fogStart, newX, newY);

          // Accumulate loot collected mask: OR in the cells picked up this turn.
          let lootCollectedMask = state.lootCollectedMask;
          if (lootDelta && lootDelta.some((b) => b !== 0)) {
            const prev = lootCollectedMask
              ? hexToBytes(lootCollectedMask)
              : new Uint8Array(BITSET_BYTES);
            const next = new Uint8Array(BITSET_BYTES);
            for (let i = 0; i < BITSET_BYTES; i++) {
              next[i] = (prev[i] ?? 0) | (lootDelta[i] ?? 0);
            }
            lootCollectedMask = bytesToHex(next);
          }

          return {
            posNonce: newNonce,
            posX: newX,
            posY: newY,
            myFogMask: bytesToHex(revealed),
            lootCollectedMask,
          };
        }),

      reset: () =>
        set({
          gameId:             null,
          ownSeedSecret:      null,
          ownMapSecret:       null,
          opponentMapSecret:  null,
          mapSeed:            null,
          sessionSeed:        null,
          posNonce:           null,
          posX:               1,
          posY:               1,
          myFogMask:          null,
          lootCollectedMask:  null,
        }),
    }),
    {
      // Use sessionStorage (per-tab) instead of localStorage (shared across tabs).
      // This ensures Player 1 and Player 2 on the same browser don't overwrite
      // each other's secrets when testing in two separate tabs.
      name: 'heist-private-state',
      storage: createJSONStorage(() => sessionStorage),
      // Only persist the data fields, not the action functions.
      partialize: (state) => ({
        gameId:             state.gameId,
        ownSeedSecret:      state.ownSeedSecret,
        ownMapSecret:       state.ownMapSecret,
        opponentMapSecret:  state.opponentMapSecret,
        mapSeed:            state.mapSeed,
        sessionSeed:        state.sessionSeed,
        posNonce:           state.posNonce,
        posX:               state.posX,
        posY:               state.posY,
        myFogMask:          state.myFogMask,
        lootCollectedMask:  state.lootCollectedMask,
      }),
    },
  ),
);
