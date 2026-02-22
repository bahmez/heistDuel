import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { FirebaseService } from '@repo/firebase';
import { LobbyStore } from './lobby.store';
import type {
  LobbyDocument,
  CreateLobbyInput,
  JoinLobbyInput,
  UpdateLobbyInput,
  PendingAuthRequest,
  SignatureResponse,
} from './lobby.model';

/**
 * NestJS injectable service for lobby persistence.
 * Wraps LobbyStore with higher-level operations and error handling.
 */
@Injectable()
export class LobbyService {
  private readonly store: LobbyStore;

  constructor(@Inject(FirebaseService) firebase: FirebaseService) {
    this.store = new LobbyStore(firebase);
  }

  /** Create a new lobby for player 1. */
  async create(input: CreateLobbyInput): Promise<LobbyDocument> {
    return this.store.create(input);
  }

  /**
   * Retrieve a lobby or throw a 404 if it does not exist.
   * Pass `orNull: true` to return null instead of throwing.
   */
  async findById(gameId: string): Promise<LobbyDocument | null> {
    return this.store.findById(gameId);
  }

  async findByIdOrThrow(gameId: string): Promise<LobbyDocument> {
    const lobby = await this.store.findById(gameId);
    if (!lobby) throw new NotFoundException(`Lobby "${gameId}" not found`);
    return lobby;
  }

  /** Apply player 2's data to an existing lobby. */
  async join(gameId: string, input: JoinLobbyInput): Promise<LobbyDocument> {
    return this.store.update(gameId, {
      player2: input.player2,
      player2SeedCommit: input.player2SeedCommit,
      player2SeedSecret: input.player2SeedSecret ?? null,
      player2MapSeedCommit: input.player2MapSeedCommit ?? null,
      player2MapSeedSecret: input.player2MapSeedSecret ?? null,
    });
  }

  /** Apply an arbitrary partial update to a lobby. */
  async update(gameId: string, updates: UpdateLobbyInput): Promise<LobbyDocument> {
    return this.store.update(gameId, updates);
  }

  /**
   * Store a pending auth-entry signing request in Firestore.
   * The frontend polls for this and signs it with the player's wallet.
   */
  async setPendingAuthRequest(
    gameId: string,
    request: PendingAuthRequest,
  ): Promise<void> {
    return this.store.setPendingAuthRequest(gameId, request);
  }

  /** Remove the pending auth request once the signature has been received. */
  async clearPendingAuthRequest(gameId: string): Promise<void> {
    return this.store.clearPendingAuthRequest(gameId);
  }

  /**
   * Persist a player's signed auth-entry response to Firestore.
   * The backend's `onSnapshot` listener will detect this and continue the game flow.
   */
  async setSignatureResponse(
    gameId: string,
    response: SignatureResponse,
  ): Promise<void> {
    return this.store.setSignatureResponse(gameId, response);
  }

  /** Remove the signature response after the backend has consumed it. */
  async clearSignatureResponse(gameId: string): Promise<void> {
    return this.store.clearSignatureResponse(gameId);
  }

  /**
   * Subscribe to real-time Firestore changes for a lobby document.
   * Used by the SSE endpoint and the signature-waiting mechanism.
   * Returns the Firestore unsubscribe function.
   */
  onSnapshot(
    gameId: string,
    callback: (lobby: LobbyDocument) => void,
  ): () => void {
    return this.store.onSnapshot(gameId, callback);
  }

  /**
   * Atomically claim the 'beginning' phase using a Firestore transaction.
   * Returns true if this caller should run the begin_match tx (won the race).
   * Returns false if another caller already claimed it.
   */
  async atomicClaimBeginning(gameId: string): Promise<boolean> {
    return this.store.atomicClaimBeginning(gameId);
  }

  /**
   * Poll until sessionSeed is available (set by the winner of the atomic race).
   * Used by the second player who must wait for the first player's tx to complete.
   */
  async waitForSessionSeed(gameId: string, timeoutMs?: number): Promise<string | null> {
    return this.store.waitForSessionSeed(gameId, timeoutMs);
  }

  async delete(gameId: string): Promise<void> {
    return this.store.delete(gameId);
  }
}
