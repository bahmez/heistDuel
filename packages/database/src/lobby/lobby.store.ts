import type { FirebaseService } from '@repo/firebase';
import type {
  LobbyDocument,
  CreateLobbyInput,
  UpdateLobbyInput,
  PendingAuthRequest,
  SignatureResponse,
} from './lobby.model';

const COLLECTION = 'lobbies';

/**
 * Firestore data-access layer for lobbies.
 * Contains only raw read/write operations — no business logic.
 */
export class LobbyStore {
  constructor(private readonly firebase: FirebaseService) {}

  private get db() {
    return this.firebase.getFirestore();
  }

  private collection() {
    return this.db.collection(COLLECTION);
  }

  /** Persist a new lobby document. */
  async create(input: CreateLobbyInput): Promise<LobbyDocument> {
    const now = new Date().toISOString();
    const doc: LobbyDocument = {
      gameId: input.gameId,
      sessionId: input.sessionId,
      player1: input.player1,
      player1SeedCommit: input.player1SeedCommit,
      player1SeedSecret: input.player1SeedSecret ?? null,
      player1MapSeedCommit: input.player1MapSeedCommit ?? null,
      player1MapSeedSecret: input.player1MapSeedSecret ?? null,
      player2: null,
      player2SeedCommit: null,
      player2SeedSecret: null,
      player2MapSeedCommit: null,
      player2MapSeedSecret: null,
      phase: 'waiting',
      createdAt: now,
      updatedAt: now,
      pendingAuthRequest: null,
    };

    await this.collection().doc(input.gameId).set(doc);
    return doc;
  }

  /** Retrieve a lobby by its gameId. Returns null if not found. */
  async findById(gameId: string): Promise<LobbyDocument | null> {
    const snap = await this.collection().doc(gameId).get();
    if (!snap.exists) return null;
    return snap.data() as LobbyDocument;
  }

  /** Apply a partial update to an existing lobby. */
  async update(
    gameId: string,
    updates: UpdateLobbyInput,
  ): Promise<LobbyDocument> {
    const ref = this.collection().doc(gameId);
    await ref.update({ ...updates, updatedAt: new Date().toISOString() });
    const snap = await ref.get();
    return snap.data() as LobbyDocument;
  }

  /** Store a pending auth-entry request that the frontend can poll. */
  async setPendingAuthRequest(
    gameId: string,
    request: PendingAuthRequest,
  ): Promise<void> {
    await this.collection().doc(gameId).update({
      pendingAuthRequest: request,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Clear the pending auth-entry request once it has been fulfilled. */
  async clearPendingAuthRequest(gameId: string): Promise<void> {
    await this.collection().doc(gameId).update({
      pendingAuthRequest: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Persist a player's signed auth-entry response.
   * The backend's `onSnapshot` listener will detect this write and resolve
   * the in-flight `requestRemoteSignature` Promise.
   */
  async setSignatureResponse(
    gameId: string,
    response: SignatureResponse,
  ): Promise<void> {
    await this.collection().doc(gameId).update({
      signatureResponse: response,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Remove the signature response after the backend has consumed it. */
  async clearSignatureResponse(gameId: string): Promise<void> {
    await this.collection().doc(gameId).update({
      signatureResponse: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Subscribe to real-time changes on a lobby document via Firestore `onSnapshot`.
   * The callback fires immediately with the current document, then on every update.
   * Returns an unsubscribe function — call it to stop listening (e.g. on SSE disconnect).
   */
  onSnapshot(
    gameId: string,
    callback: (lobby: LobbyDocument) => void,
  ): () => void {
    return this.collection()
      .doc(gameId)
      .onSnapshot((snap) => {
        if (snap.exists) {
          callback(snap.data() as LobbyDocument);
        }
      });
  }

  /**
   * Atomically claim the 'beginning' phase using a Firestore transaction.
   * Returns true if this caller successfully transitioned phase from 'relaying'
   * to 'beginning' (this caller should run the begin_match tx).
   * Returns false if another caller already claimed it (this caller should wait).
   */
  async atomicClaimBeginning(gameId: string): Promise<boolean> {
    const ref = this.collection().doc(gameId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = snap.data() as LobbyDocument;
      if (data.phase !== 'relaying') return false;
      tx.update(ref, { phase: 'beginning', updatedAt: new Date().toISOString() });
      return true;
    });
  }

  /**
   * Poll for sessionSeed with exponential back-off. Used by the second player
   * who lost the atomic claim race and must wait for the first player's tx.
   */
  async waitForSessionSeed(
    gameId: string,
    timeoutMs = 90_000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    let delay = 500;
    while (Date.now() < deadline) {
      const snap = await this.collection().doc(gameId).get();
      if (snap.exists) {
        const data = snap.data() as LobbyDocument;
        if (data.sessionSeed) return data.sessionSeed;
        if (data.phase === 'error') return null;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 4_000);
    }
    return null;
  }

  /** Delete a lobby document. */
  async delete(gameId: string): Promise<void> {
    await this.collection().doc(gameId).delete();
  }

  /** List all lobbies (admin / debug use only). */
  async list(): Promise<LobbyDocument[]> {
    const snap = await this.collection().get();
    return snap.docs.map((d: FirebaseFirestore.QueryDocumentSnapshot) => d.data() as LobbyDocument);
  }
}
