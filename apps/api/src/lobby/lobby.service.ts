import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { authorizeEntry, xdr } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
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
 * Never includes seed secrets or map secrets.
 */
export interface LobbyPublicView {
  gameId: string;
  sessionId: number;
  player1: string;
  player2: string | null;
  phase: LobbyPhase;
  createdAt: string;
  error?: string;
  pendingAuthRequest: PendingAuthRequest | null;
}

/**
 * Payload returned to a player after the backend relays map secrets.
 * Contains the opponent's map secret so the player can compute the shared map_seed.
 */
export interface MapSecretRelayResult {
  /** The opponent's map secret (hex). Combine with your own via keccak(yours XOR theirs). */
  opponentMapSecret: string;
}

/**
 * Application-layer lobby service.
 *
 * ZK Map Relay Flow (new):
 *  1. Players provide mapSeedCommit (on-chain) and mapSeedSecret (off-chain) at create/join.
 *  2. After both dice seeds are revealed, backend enters 'relaying' phase.
 *  3. Backend verifies keccak(mapSeedSecret_i) == mapSeedCommit_i (from on-chain data).
 *  4. Backend cross-relays secrets: P1 receives secret2, P2 receives secret1.
 *  5. Each player computes: map_seed = keccak(secret1 XOR secret2).
 *  6. Each player computes: map_data = generate_map(map_seed), map_commitment = keccak(map_data).
 *  7. Both players sign begin_match(map_commitment, p1_pos_commit, p2_pos_commit).
 *
 * The backend acts as a one-time relay — map secrets are cleared after relaying.
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
    mapSeedCommit: string,
    mapSeedSecret: string,
  ): Promise<{ gameId: string; sessionId: number; joinUrl: string }> {
    const gameId = uuidv4().slice(0, 8);
    const sessionId = this.generateSessionId();

    const lobby = await this.dbLobby.create({
      gameId,
      sessionId,
      player1: playerAddress,
      player1SeedCommit: seedCommit,
      player1SeedSecret: seedSecret,
      player1MapSeedCommit: mapSeedCommit,
      player1MapSeedSecret: mapSeedSecret,
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
    mapSeedCommit: string,
    mapSeedSecret: string,
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
      player2MapSeedCommit: mapSeedCommit,
      player2MapSeedSecret: mapSeedSecret,
    });

    this.logger.log(`Player 2 joined — gameId: ${gameId}, player2: ${playerAddress}`);

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

  async getLobbyPublicView(gameId: string): Promise<LobbyPublicView> {
    const lobby = await this.dbLobby.findByIdOrThrow(gameId);
    return this.sanitize(lobby);
  }

  subscribeToLobby(
    gameId: string,
    callback: (view: LobbyPublicView) => void,
  ): () => void {
    return this.dbLobby.onSnapshot(gameId, (doc) => {
      callback(this.sanitize(doc));
    });
  }

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
  }

  /**
   * Map secret relay endpoint.
   *
   * Called by each player to submit their map_secret to the backend.
   * Once both secrets are received and verified against on-chain commitments,
   * the backend returns the opponent's secret.
   *
   * Security: the backend verifies keccak(secret) == mapSeedCommit before relaying.
   */
  async relayMapSecret(
    gameId: string,
    playerAddress: string,
    mapSecret: string,
  ): Promise<MapSecretRelayResult> {
    const lobby = await this.dbLobby.findByIdOrThrow(gameId);

    if (lobby.phase !== 'relaying') {
      throw new BadRequestException(
        `Cannot relay map secret in phase '${lobby.phase}'. Wait until phase is 'relaying'.`,
      );
    }

    const isPlayer1 = lobby.player1 === playerAddress;
    const isPlayer2 = lobby.player2 === playerAddress;

    if (!isPlayer1 && !isPlayer2) {
      throw new BadRequestException('Not a player in this lobby');
    }

    // Verify the provided secret matches the on-chain commitment.
    const expectedCommit = isPlayer1
      ? lobby.player1MapSeedCommit
      : lobby.player2MapSeedCommit;

    if (!expectedCommit) {
      throw new BadRequestException('Map seed commitment not found for player');
    }

    const computedCommit = this.keccakHex(mapSecret);
    if (computedCommit !== expectedCommit.toLowerCase()) {
      throw new BadRequestException('Map secret does not match on-chain commitment');
    }

    // Return the opponent's secret (which the backend already has from create/join).
    const opponentSecret = isPlayer1
      ? lobby.player2MapSeedSecret
      : lobby.player1MapSeedSecret;

    if (!opponentSecret) {
      throw new NotFoundException('Opponent map secret not yet available. Try again shortly.');
    }

    this.logger.log(
      `[${gameId}] Map secret relay for ${playerAddress} — opponent secret delivered`,
    );

    return { opponentMapSecret: opponentSecret };
  }

  // ─── Game Setup Flow ────────────────────────────────────────────────────────

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
    const p1MapCommit = this.hexToBytes(lobby.player1MapSeedCommit ?? '');
    const p2MapCommit = this.hexToBytes(lobby.player2MapSeedCommit ?? '');

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
        p1MapCommit,
        p2MapCommit,
      );

      this.logger.log(`[start_game] Built tx with ${authInfos.length} auth entries`);

      const result = await this.signAllAndSubmit(gameId, 'start_game', txXdr, authInfos);
      this.logger.log(`[start_game] Confirmed: ${result.hash}`);

      await this.handleRevealSeeds(gameId, result.confirmedViaSequence);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`[start_game] Failed: ${msg}`, stack);
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
      await this.stellar.sleep(POST_SEQ_FALLBACK_DELAY_MS);
    }

    // Enter relaying phase — players must now call POST /lobby/:gameId/map-secret
    // to exchange their map secrets via the backend relay.
    // The backend transitions to 'beginning' once both players have the opponent secret
    // and are ready to call begin_match.
    await this.dbLobby.update(gameId, { phase: 'relaying' });
    this.logger.log(`[${gameId}] Phase → relaying (awaiting begin_match from players)`);
  }

  /**
   * Called by a player after they have exchanged map secrets and computed
   * map_commitment, p1_pos_commit, p2_pos_commit locally.
   * Both players must submit the same map_commitment for begin_match to succeed.
   */
  async handleBeginMatch(
    gameId: string,
    mapCommitment: string,
    p1PosCommit: string,
    p2PosCommit: string,
  ): Promise<void> {
    await this.dbLobby.update(gameId, { phase: 'beginning' });
    this.logger.log(`[${gameId}] Phase → beginning`);

    const lobby = await this.dbLobby.findByIdOrThrow(gameId);
    const client = this.stellar.getClient();
    const source = this.stellar.getSourceAddress();

    try {
      const { txXdr, authInfos } = await this.withSimulationRetry(
        'begin_match_build',
        () =>
          client.buildBeginMatchTx(
            source,
            lobby.sessionId,
            this.hexToBytes(mapCommitment),
            this.hexToBytes(p1PosCommit),
            this.hexToBytes(p2PosCommit),
          ),
        { maxAttempts: SIM_RETRY_ATTEMPTS_EXTENDED, delayMs: SIM_RETRY_DELAY_MS_EXTENDED },
      );

      const result = await this.signAllAndSubmit(gameId, 'begin_match', txXdr, authInfos);
      this.logger.log(`[begin_match] Confirmed: ${result.hash}`);

      // Clear map secrets now that they are no longer needed.
      await this.dbLobby.update(gameId, {
        phase: 'active',
        player1MapSeedSecret: null,
        player2MapSeedSecret: null,
      });
      this.logger.log(`[${gameId}] Phase → active (map secrets cleared)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`[begin_match] Failed: ${msg}`, stack);
      await this.dbLobby.update(gameId, { phase: 'error', error: msg });
    }
  }

  // ─── Auth Signature Coordination ────────────────────────────────────────────

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
    }

    return this.stellar.signAndSubmit(finalTxXdr, purpose);
  }

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

        await this.dbLobby.clearSignatureResponse(gameId).catch(() => {});

        const pendingReq: PendingAuthRequest = {
          purpose,
          playerAddress,
          preimageXdr,
          requestedAt: new Date().toISOString(),
        };
        await this.dbLobby.setPendingAuthRequest(gameId, pendingReq);

        return new Promise<Buffer>((resolve, reject) => {
          let unsubscribe: (() => void) | null = null;

          const timeout = setTimeout(async () => {
            if (unsubscribe) unsubscribe();
            await this.dbLobby.clearPendingAuthRequest(gameId).catch(() => {});
            reject(new Error(`Signature timeout for ${playerAddress} (${purpose})`));
          }, SIGN_TIMEOUT_MS);

          unsubscribe = this.dbLobby.onSnapshot(gameId, async (lobby) => {
            const resp = lobby.signatureResponse;
            if (
              resp &&
              resp.purpose === purpose &&
              resp.playerAddress === playerAddress
            ) {
              clearTimeout(timeout);
              if (unsubscribe) unsubscribe();

              await Promise.all([
                this.dbLobby.clearPendingAuthRequest(gameId),
                this.dbLobby.clearSignatureResponse(gameId),
              ]).catch(() => {});

              try {
                const normalized = this.stellar.normalizeWalletSignature(resp.signatureBase64);
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

  /** Compute keccak256 of a hex string and return as hex. */
  private keccakHex(hexInput: string): string {
    const bytes = Buffer.from(hexInput, 'hex');
    return createHash('sha3-256').update(bytes).digest('hex');
  }

  private isRetriableSimulationError(msg: string): boolean {
    return (
      msg.includes('Error(Contract, #1)') ||
      msg.includes('Error(Contract, #7)') ||
      msg.includes('Error(Contract, #17)')
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
    return Math.floor(Math.random() * 0x7fffffff) + 1;
  }

  private hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return bytes;
  }
}
