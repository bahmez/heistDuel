import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { authorizeEntry, xdr } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';
import { LobbyService as DbLobbyService } from '@repo/database';
import type {
  LobbyDocument,
  LobbyPhase,
  PendingAuthRequest,
  SignatureResponse,
} from '@repo/database';
import { StellarService } from '../stellar/stellar.service';
import { HeistContractClient, NETWORK_PASSPHRASE } from '@repo/stellar';
import type { AuthEntryInfo } from '@repo/stellar';

const SIGN_TIMEOUT_MS = 120_000;
const SIM_RETRY_ATTEMPTS = 8;
const SIM_RETRY_DELAY_MS = 2_000;
const SIM_RETRY_ATTEMPTS_EXTENDED = 25;
const SIM_RETRY_DELAY_MS_EXTENDED = 5_000;
const POST_SEQ_FALLBACK_DELAY_MS = 15_000;

/**
 * Sanitized lobby view sent to clients (over SSE or REST).
 * Omits seed secrets and other sensitive fields.
 */
export interface LobbyPublicView {
  gameId: string;
  sessionId: number;
  player1: string;
  player2: string | null;
  phase: LobbyPhase;
  createdAt: string;
  error?: string;
  /** Present during signing phases — tells the client which preimage to sign. */
  pendingAuthRequest: PendingAuthRequest | null;
}

/**
 * Application-layer lobby service.
 *
 * Handles:
 *  - Lobby creation / join
 *  - Game-start coordination (start_game → reveal_seed × 2 → begin_match)
 *  - Auth-entry signature collection via SSE + Firestore (replacing in-memory resolvers)
 *
 * The signature collection pattern:
 *  1. Backend stores `pendingAuthRequest` in Firestore (frontend sees it via SSE).
 *  2. Frontend signs the preimage with the player's wallet.
 *  3. Frontend POSTs the signature to POST /api/lobby/:gameId/auth-response.
 *  4. Backend writes `signatureResponse` to Firestore.
 *  5. Backend's `onSnapshot` listener detects the response and resolves the awaited Promise.
 *  6. Backend clears both fields and continues the game flow.
 */
@Injectable()
export class LobbyService {
  private readonly logger = new Logger(LobbyService.name);

  constructor(
    private readonly dbLobby: DbLobbyService,
    private readonly stellar: StellarService,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  async createLobby(
    playerAddress: string,
    seedCommit: string,
    seedSecret: string,
  ): Promise<{ gameId: string; sessionId: number; joinUrl: string }> {
    const gameId = uuidv4().slice(0, 8);
    const sessionId = this.generateSessionId();

    const lobby = await this.dbLobby.create({
      gameId,
      sessionId,
      player1: playerAddress,
      player1SeedCommit: seedCommit,
      player1SeedSecret: seedSecret,
    });

    this.logger.log(
      `Lobby created — gameId: ${gameId}, sessionId: ${sessionId}, player1: ${playerAddress}`,
    );

    return { gameId: lobby.gameId, sessionId: lobby.sessionId, joinUrl: `/game/${gameId}` };
  }

  async joinLobby(
    gameId: string,
    playerAddress: string,
    seedCommit: string,
    seedSecret: string,
  ): Promise<LobbyDocument> {
    const lobby = await this.dbLobby.findByIdOrThrow(gameId);

    if (lobby.phase !== 'waiting') {
      throw new BadRequestException('Game already started');
    }
    if (lobby.player1 === playerAddress) {
      throw new BadRequestException('Cannot join your own game');
    }

    const updated = await this.dbLobby.join(gameId, {
      player2: playerAddress,
      player2SeedCommit: seedCommit,
      player2SeedSecret: seedSecret,
    });

    this.logger.log(`Player 2 joined — gameId: ${gameId}, player2: ${playerAddress}`);

    // Kick off the game setup flow in the background (non-blocking)
    this.initiateStartGame(gameId).catch((err: Error) => {
      this.logger.error(
        `Game setup failed for ${gameId}: ${err.message}`,
        err.stack,
      );
    });

    return updated;
  }

  async getLobby(gameId: string): Promise<LobbyDocument> {
    return this.dbLobby.findByIdOrThrow(gameId);
  }

  /**
   * Return the sanitized lobby state safe for the client.
   * Used by both the REST GET endpoint and the SSE stream.
   */
  async getLobbyPublicView(gameId: string): Promise<LobbyPublicView> {
    const lobby = await this.dbLobby.findByIdOrThrow(gameId);
    return this.sanitize(lobby);
  }

  /**
   * Subscribe to real-time Firestore changes for a lobby and push the
   * sanitized `LobbyPublicView` to the callback on every update.
   *
   * Used by the SSE endpoint — the returned unsubscribe function should be
   * called when the SSE connection closes.
   */
  subscribeToLobby(
    gameId: string,
    callback: (view: LobbyPublicView) => void,
  ): () => void {
    return this.dbLobby.onSnapshot(gameId, (doc) => {
      callback(this.sanitize(doc));
    });
  }

  /**
   * Receive a signed auth entry from the frontend.
   * Writes the `signatureResponse` to Firestore — the backend's `onSnapshot`
   * listener (in `requestRemoteSignature`) will pick it up and resolve the
   * awaited Promise, replacing the old in-memory resolver map.
   */
  async receiveAuthSignature(
    gameId: string,
    purpose: string,
    playerAddress: string,
    signatureBase64: string,
  ): Promise<void> {
    this.logger.log(`[${purpose}] Signature received from ${playerAddress}`);

    const response: SignatureResponse = {
      purpose,
      playerAddress,
      signatureBase64,
      respondedAt: new Date().toISOString(),
    };

    await this.dbLobby.setSignatureResponse(gameId, response);
    this.logger.debug(`[${purpose}] signatureResponse written to Firestore`);
  }

  // ─── Game Setup Flow ────────────────────────────────────────────────────────

  /**
   * Orchestrates the full game initialization sequence:
   *   start_game → reveal_seed (×2) → begin_match
   *
   * Runs entirely in the background after player 2 joins.
   * Updates lobby phase in Firestore so the frontend tracks progress via SSE.
   */
  private async initiateStartGame(gameId: string): Promise<void> {
    const lobby = await this.dbLobby.findByIdOrThrow(gameId);

    if (!lobby.player2 || !lobby.player2SeedCommit) {
      throw new Error('Lobby not ready — player 2 data missing');
    }

    await this.dbLobby.update(gameId, { phase: 'starting' });
    this.logger.log(`[${gameId}] Phase → starting`);

    const client = this.stellar.getClient();
    const source = this.stellar.getSourceAddress();

    const p1Commit = this.hexToBytes(lobby.player1SeedCommit);
    const p2Commit = this.hexToBytes(lobby.player2SeedCommit);

    try {
      const { txXdr, authInfos } = await client.buildStartGameTx(
        source,
        lobby.sessionId,
        lobby.player1,
        lobby.player2,
        0n,
        0n,
        p1Commit,
        p2Commit,
      );

      this.logger.log(`[start_game] Built tx with ${authInfos.length} auth entries`);

      const result = await this.signAllAndSubmit(gameId, 'start_game', txXdr, authInfos);
      this.logger.log(`[start_game] Confirmed: ${result.hash}`);

      await this.handleRevealSeeds(gameId, result.confirmedViaSequence);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[start_game] Failed: ${msg}`);
      await this.dbLobby.update(gameId, { phase: 'error', error: msg });
    }
  }

  private async handleRevealSeeds(
    gameId: string,
    anySeqFallback: boolean,
  ): Promise<void> {
    await this.dbLobby.update(gameId, { phase: 'revealing' });
    this.logger.log(`[${gameId}] Phase → revealing`);

    const lobby = await this.dbLobby.findByIdOrThrow(gameId);

    if (!lobby.player1SeedSecret || !lobby.player2SeedSecret) {
      throw new Error('Seeds not available for reveal');
    }

    const client = this.stellar.getClient();
    const source = this.stellar.getSourceAddress();

    const r1 = await this.withSimulationRetry('reveal_seed_p1_build', () =>
      client.buildRevealSeedTx(
        source,
        lobby.sessionId,
        lobby.player1,
        this.hexToBytes(lobby.player1SeedSecret!),
      ),
    );
    const res1 = await this.signAllAndSubmit(gameId, 'reveal_seed_p1', r1.txXdr, r1.authInfos);
    this.logger.log(`[reveal_seed_p1] Confirmed: ${res1.hash}`);
    if (res1.confirmedViaSequence) anySeqFallback = true;

    const r2 = await this.withSimulationRetry('reveal_seed_p2_build', () =>
      client.buildRevealSeedTx(
        source,
        lobby.sessionId,
        lobby.player2!,
        this.hexToBytes(lobby.player2SeedSecret!),
      ),
    );
    const res2 = await this.signAllAndSubmit(gameId, 'reveal_seed_p2', r2.txXdr, r2.authInfos);
    this.logger.log(`[reveal_seed_p2] Confirmed: ${res2.hash}`);
    if (res2.confirmedViaSequence) anySeqFallback = true;

    if (anySeqFallback) {
      this.logger.log(
        `[${gameId}] Waiting ${POST_SEQ_FALLBACK_DELAY_MS / 1000}s for RPC to catch up after sequence-fallback...`,
      );
      await this.stellar.sleep(POST_SEQ_FALLBACK_DELAY_MS);
    }

    await this.handleBeginMatch(gameId, anySeqFallback);
  }

  private async handleBeginMatch(
    gameId: string,
    useExtendedRetry: boolean,
  ): Promise<void> {
    await this.dbLobby.update(gameId, { phase: 'beginning' });
    this.logger.log(`[${gameId}] Phase → beginning`);

    const lobby = await this.dbLobby.findByIdOrThrow(gameId);
    const client = this.stellar.getClient();
    const source = this.stellar.getSourceAddress();

    const retryOpts = useExtendedRetry
      ? { maxAttempts: SIM_RETRY_ATTEMPTS_EXTENDED, delayMs: SIM_RETRY_DELAY_MS_EXTENDED }
      : undefined;

    try {
      const { txXdr, authInfos } = await this.withSimulationRetry(
        'begin_match_build',
        () => client.buildBeginMatchTx(source, lobby.sessionId),
        retryOpts,
      );

      const result = await this.signAllAndSubmit(gameId, 'begin_match', txXdr, authInfos);
      this.logger.log(`[begin_match] Confirmed: ${result.hash}`);

      await this.dbLobby.update(gameId, { phase: 'active' });
      this.logger.log(`[${gameId}] Phase → active 🎮`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[begin_match] Failed: ${msg}`);
      await this.dbLobby.update(gameId, { phase: 'error', error: msg });
    }
  }

  // ─── Auth Signature Coordination ────────────────────────────────────────────

  /**
   * Sign all auth entries for a transaction and submit it.
   *
   * Auth entries are processed ONE AT A TIME (sequentially) because
   * Firestore only holds a single `pendingAuthRequest` slot per lobby.
   * Running them in parallel would cause concurrent writes to overwrite
   * each other, making some signature requests invisible to the frontend.
   */
  private async signAllAndSubmit(
    gameId: string,
    purpose: string,
    txXdr: string,
    authInfos: AuthEntryInfo[],
  ) {
    if (authInfos.length === 0) {
      return this.stellar.signAndSubmit(txXdr, purpose);
    }

    this.logger.log(
      `[${purpose}] Collecting ${authInfos.length} auth signature(s) sequentially`,
    );

    let finalTxXdr = txXdr;

    for (const info of authInfos) {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(
        info.authEntryXdr,
        'base64',
      );

      this.logger.log(
        `[${purpose}] Requesting signature from ${info.address} (entry #${info.index})`,
      );

      const signedEntry = await this.requestRemoteSignature(
        gameId,
        purpose,
        entry,
        info.address,
        info.expirationLedger,
      );

      finalTxXdr = HeistContractClient.replaceAuthEntry(
        finalTxXdr,
        info.index,
        signedEntry.toXDR('base64'),
      );

      this.logger.log(`[${purpose}] Entry #${info.index} signed — tx updated`);
    }

    return this.stellar.signAndSubmit(finalTxXdr, purpose);
  }

  /**
   * Request a signature from a player's wallet via SSE + Firestore signaling.
   *
   * Flow:
   *  1. Clear any stale `signatureResponse` from a previous round.
   *  2. Write `pendingAuthRequest` to Firestore → frontend sees it via SSE and signs.
   *  3. Frontend POSTs the signature → `receiveAuthSignature()` writes `signatureResponse`.
   *  4. Firestore `onSnapshot` detects the write → Promise resolves with the signature.
   *  5. Clear both Firestore fields and continue.
   *
   * Replaces the old in-memory `sigResolvers` Map — the signal now travels through
   * Firestore so it survives API restarts and is durably stored.
   */
  private async requestRemoteSignature(
    gameId: string,
    purpose: string,
    authEntry: xdr.SorobanAuthorizationEntry,
    playerAddress: string,
    expirationLedger: number,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    return authorizeEntry(
      authEntry,
      async (preimage) => {
        const preimageXdr = preimage.toXDR('base64');

        // Clear any stale response from a previous signing round
        await this.dbLobby.clearSignatureResponse(gameId).catch(() => {});

        // Write the pending request — SSE will push it to the frontend immediately
        const pendingReq: PendingAuthRequest = {
          purpose,
          playerAddress,
          preimageXdr,
          requestedAt: new Date().toISOString(),
        };
        await this.dbLobby.setPendingAuthRequest(gameId, pendingReq);
        this.logger.log(
          `[${purpose}] pendingAuthRequest written to Firestore for ${playerAddress}`,
        );

        return new Promise<Buffer>((resolve, reject) => {
          let unsubscribe: (() => void) | null = null;

          const timeout = setTimeout(async () => {
            if (unsubscribe) unsubscribe();
            await this.dbLobby.clearPendingAuthRequest(gameId).catch(() => {});
            reject(new Error(`Signature timeout for ${playerAddress} (${purpose})`));
          }, SIGN_TIMEOUT_MS);

          // Listen for the signatureResponse in Firestore instead of an in-memory map
          unsubscribe = this.dbLobby.onSnapshot(gameId, async (lobby) => {
            const resp = lobby.signatureResponse;
            if (
              resp &&
              resp.purpose === purpose &&
              resp.playerAddress === playerAddress
            ) {
              clearTimeout(timeout);
              if (unsubscribe) unsubscribe();

              // Clean up Firestore fields before resolving
              await Promise.all([
                this.dbLobby.clearPendingAuthRequest(gameId),
                this.dbLobby.clearSignatureResponse(gameId),
              ]).catch(() => {});

              this.logger.log(
                `[${purpose}] Signature received via Firestore for ${playerAddress}`,
              );

              try {
                const normalized = this.stellar.normalizeWalletSignature(resp.signatureBase64);
                this.logger.debug(
                  `[${purpose}] Normalized signature length: ${normalized.length}`,
                );
                resolve(normalized);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                reject(new Error(msg));
              }
            }
          });
        });
      },
      expirationLedger,
      NETWORK_PASSPHRASE,
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Strip sensitive fields before sending lobby data to the client. */
  private sanitize(doc: LobbyDocument): LobbyPublicView {
    return {
      gameId: doc.gameId,
      sessionId: doc.sessionId,
      player1: doc.player1,
      player2: doc.player2 ?? null,
      phase: doc.phase,
      createdAt: doc.createdAt,
      error: doc.error,
      pendingAuthRequest: doc.pendingAuthRequest ?? null,
    };
  }

  private isRetriableSimulationError(msg: string): boolean {
    return (
      msg.includes('Error(Contract, #1)') || // GameNotFound
      msg.includes('Error(Contract, #7)') || // SeedsNotReady
      msg.includes('Error(Contract, #17)')   // InvalidStatus
    );
  }

  private async withSimulationRetry<T>(
    label: string,
    fn: () => Promise<T>,
    opts?: { maxAttempts?: number; delayMs?: number },
  ): Promise<T> {
    const maxAttempts = opts?.maxAttempts ?? SIM_RETRY_ATTEMPTS;
    const delayMs = opts?.delayMs ?? SIM_RETRY_DELAY_MS;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErr = err;
        if (!this.isRetriableSimulationError(msg) || attempt === maxAttempts) {
          throw err;
        }
        this.logger.warn(
          `[${label}] Simulation not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`,
        );
        await this.stellar.sleep(delayMs);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private generateSessionId(): number {
    const candidate = Math.floor(Math.random() * 0x7fffffff) + 1;
    return candidate;
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }
}
