import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Keypair,
  rpc,
  xdr,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { HeistContractClient, NETWORK_PASSPHRASE } from '@repo/stellar';
import { ConfigService } from '../config/config.service';

export interface SubmitResult {
  hash: string;
  /** true when confirmed via account-sequence heuristic instead of getTransaction */
  confirmedViaSequence: boolean;
}

const TRY_AGAIN_MAX_RETRIES = 8;
const TRY_AGAIN_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_POLL_WAIT_MS = 120_000;
const BAD_SEQ_MAX_RETRIES = 5;
const BAD_SEQ_DELAY_MS = 3_000;

/**
 * NestJS service wrapping Stellar/Soroban interactions.
 *
 * Responsibilities:
 *  - Holding the backend source keypair
 *  - Exposing a HeistContractClient instance
 *  - Signing and submitting transactions with retry / polling logic
 *
 * Contract addresses are resolved at startup via ConfigService (Firestore
 * deployment table → env var fallback), so no .env changes are needed after
 * running the deploy script.
 */
@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);

  private rpcUrl!: string;
  private contractId!: string;
  private verifierContractId!: string;

  private sourceKeypair!: Keypair;
  private client!: HeistContractClient;
  private clientContractId = '';

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    // ConfigService can finish loading Firestore slightly later in the Nest
    // lifecycle. We therefore avoid freezing contract IDs at startup and
    // resolve them lazily in getClient()/signAndSubmit().
    this.refreshRuntimeConfig();

    const secret = process.env.SOURCE_SECRET;
    const isCloudRun = !!process.env.K_SERVICE;

    if (!secret) {
      if (isCloudRun) {
        throw new Error(
          'SOURCE_SECRET is missing in Cloud Run. ' +
            'Set _API_SOURCE_SECRET (or SOURCE_SECRET) for the API service.',
        );
      }
      this.logger.warn(
        'SOURCE_SECRET not set — generating a temporary keypair. ' +
          'Multi-auth transactions will fail until the account is funded.',
      );
      this.sourceKeypair = Keypair.random();
      this.logger.log(`Temp keypair: ${this.sourceKeypair.publicKey()}`);
      this.logger.log(
        `Fund via friendbot: https://friendbot.stellar.org/?addr=${this.sourceKeypair.publicKey()}`,
      );
    } else {
      this.sourceKeypair = Keypair.fromSecret(secret);
    }

    if (!this.contractId) {
      this.logger.warn(
        'Heist contract ID is empty at startup. Waiting for ConfigService to load Firestore deployment...',
      );
    }

    this.logger.log(
      `Stellar service ready — source: ${this.sourceKeypair.publicKey()} ` +
        `contract: ${this.contractId ? `${this.contractId.slice(0, 8)}…` : '(unset)'}`,
    );
  }

  /** Refresh runtime config values from ConfigService (Firestore/env). */
  private refreshRuntimeConfig(): void {
    this.rpcUrl = this.configService.get('rpcUrl');
    this.contractId = this.configService.get('heistContractId');
    this.verifierContractId = this.configService.get('zkVerifierContractId');
  }

  getSourceKeypair(): Keypair {
    return this.sourceKeypair;
  }

  getSourceAddress(): string {
    return this.sourceKeypair.publicKey();
  }

  getClient(): HeistContractClient {
    this.refreshRuntimeConfig();
    if (!this.contractId) {
      throw new Error(
        'Heist contract ID is still empty. ' +
          'Ensure ConfigService loaded Firestore deployment or HEIST_CONTRACT_ID is set.',
      );
    }
    if (!this.client || this.clientContractId !== this.contractId) {
      this.client = new HeistContractClient(this.contractId, this.rpcUrl);
      this.clientContractId = this.contractId;
      this.logger.log(
        `Stellar client bound to contract ${this.contractId.slice(0, 8)}…`,
      );
    }
    return this.client;
  }

  getRpcUrl(): string {
    this.refreshRuntimeConfig();
    return this.rpcUrl;
  }

  getVerifierContractId(): string {
    this.refreshRuntimeConfig();
    return this.verifierContractId;
  }

  /**
   * Sign a transaction XDR with the backend keypair and submit it to the network.
   *
   * Strategy:
   * - Retry on TRY_AGAIN_LATER (tx not forwarded yet — safe to resend).
   * - Retry on txBAD_SEQ by rebuilding the transaction with a fresh sequence
   *   number. Player Soroban auth entries remain valid because their preimage
   *   does not include the outer envelope sequence number.
   * - Poll getTransaction for up to 120 s.
   * - Fall back to account-sequence heuristic if still NOT_FOUND after polling.
   */
  async signAndSubmit(txXdr: string, label = 'tx'): Promise<SubmitResult> {
    this.refreshRuntimeConfig();
    if (!this.rpcUrl) {
      throw new Error('Missing Soroban RPC URL for signAndSubmit.');
    }

    const kp = this.sourceKeypair;
    const server = new rpc.Server(this.rpcUrl);

    let tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
    tx.signatures.splice(0);
    tx.sign(kp);

    let sendResult: rpc.Api.SendTransactionResponse | null = null;

    for (let badSeqAttempt = 0; badSeqAttempt <= BAD_SEQ_MAX_RETRIES; badSeqAttempt++) {
      // Submit with TRY_AGAIN_LATER retries
      for (let attempt = 0; attempt <= TRY_AGAIN_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          this.logger.log(
            `[${label}] TRY_AGAIN_LATER — waiting ${TRY_AGAIN_DELAY_MS / 1000}s before retry (${attempt}/${TRY_AGAIN_MAX_RETRIES})`,
          );
          await this.sleep(TRY_AGAIN_DELAY_MS);
        }
        sendResult = await server.sendTransaction(tx);
        this.logger.log(
          `[${label}] send status=${sendResult.status} hash=${sendResult.hash}`,
        );
        if (sendResult.status !== 'TRY_AGAIN_LATER') break;
      }

      if (!sendResult) throw new Error('sendTransaction never attempted');
      if (sendResult.status === 'TRY_AGAIN_LATER') {
        throw new Error(
          `Send failed: still TRY_AGAIN_LATER after ${TRY_AGAIN_MAX_RETRIES} retries`,
        );
      }

      // On txBAD_SEQ: rebuild with a fresh sequence number and retry.
      // Player Soroban auth entries embedded in operations are sequence-agnostic.
      if (sendResult.status === 'ERROR' && this.isBadSeqError(sendResult)) {
        if (badSeqAttempt >= BAD_SEQ_MAX_RETRIES) break;
        this.logger.warn(
          `[${label}] txBAD_SEQ detected — fetching fresh sequence and rebuilding (attempt ${badSeqAttempt + 1}/${BAD_SEQ_MAX_RETRIES})`,
        );
        await this.sleep(BAD_SEQ_DELAY_MS);
        tx = await this.rebuildWithFreshSequence(server, tx, kp, label);
        sendResult = null;
        continue;
      }

      break;
    }

    if (!sendResult) throw new Error('sendTransaction never attempted');

    if (sendResult.status === 'ERROR') {
      throw new Error(
        `Send failed: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`,
      );
    }

    // Capture expected post-tx sequence for the heuristic fallback
    const txSequence = BigInt((tx as Transaction).sequence);
    const expectedSeqAfter = txSequence; // after submission, account seq === tx.sequence

    // Poll getTransaction
    const start = Date.now();
    let getResult = await server.getTransaction(sendResult.hash);

    while (
      getResult.status === 'NOT_FOUND' &&
      Date.now() - start < MAX_POLL_WAIT_MS
    ) {
      await this.sleep(POLL_INTERVAL_MS);
      getResult = await server.getTransaction(sendResult.hash);
    }

    if (getResult.status === 'SUCCESS') {
      return { hash: sendResult.hash, confirmedViaSequence: false };
    }

    // Account-sequence heuristic fallback
    if (getResult.status === 'NOT_FOUND') {
      const accountAfter = await server.getAccount(kp.publicKey());
      const seqAfter = BigInt(accountAfter.sequenceNumber());

      if (seqAfter === expectedSeqAfter) {
        this.logger.warn(
          `[${label}] getTransaction returned NOT_FOUND but account sequence ` +
            `advanced to ${seqAfter} as expected. Treating as success.`,
        );
        return { hash: sendResult.hash, confirmedViaSequence: true };
      }

      throw new Error(
        `[${label}] Transaction NOT_FOUND after ${MAX_POLL_WAIT_MS / 1000}s ` +
          `and sequence is ${seqAfter} (expected ${expectedSeqAfter}). ` +
          `hash: ${sendResult.hash}`,
      );
    }

    // Extract Soroban diagnostic info from failed tx
    const details = this.extractFailureDetails(getResult, label);
    this.logger.error(details);
    throw new Error(details);
  }

  /** Returns true when the send error is txBAD_SEQ (-5). */
  private isBadSeqError(sendResult: rpc.Api.SendTransactionResponse): boolean {
    try {
      const resultCode = sendResult.errorResult?.result().switch().value;
      return resultCode === -5; // TransactionResultCode.txBAD_SEQ
    } catch {
      return false;
    }
  }

  /**
   * Rebuild a Soroban transaction with a fresh sequence number while preserving:
   *  - All XDR operations (including embedded player Soroban auth entries)
   *  - The SorobanTransactionData extension (footprint + resource limits)
   *  - The original fee and time bounds
   *
   * Player auth preimages don't include the outer envelope sequence, so their
   * signatures remain valid after rebuild.
   */
  private async rebuildWithFreshSequence(
    server: rpc.Server,
    original: ReturnType<typeof TransactionBuilder.fromXDR>,
    kp: Keypair,
    label: string,
  ): Promise<ReturnType<typeof TransactionBuilder.fromXDR>> {
    const freshAccount = await server.getAccount(kp.publicKey());
    this.logger.log(
      `[${label}] Rebuilding with fresh sequence: ${freshAccount.sequenceNumber()}`,
    );

    const tx = original as Transaction;
    const envelope = tx.toEnvelope().v1();
    const innerTx = envelope.tx();

    const builder = new TransactionBuilder(freshAccount, {
      fee: tx.fee,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    // Copy Soroban resource data (footprint + resource limits) from the original
    // assembled transaction. Without this, the tx is rejected as txMALFORMED.
    try {
      const ext = innerTx.ext();
      if ((ext.switch() as unknown as number) === 1) {
        builder.setSorobanData(ext.sorobanData());
      }
    } catch {
      this.logger.warn(`[${label}] Could not extract Soroban ext data — tx may lack resource footprint`);
    }

    // Copy raw XDR operations to avoid Operation vs Operation2 type mismatch
    // and to preserve embedded Soroban auth entries exactly as-is.
    for (const xdrOp of innerTx.operations()) {
      builder.addOperation(xdrOp);
    }

    if (tx.timeBounds) {
      builder.setTimebounds(
        Number(tx.timeBounds.minTime),
        Number(tx.timeBounds.maxTime),
      );
    } else {
      builder.setTimeout(300);
    }

    const rebuilt = builder.build() as ReturnType<typeof TransactionBuilder.fromXDR>;
    rebuilt.signatures.splice(0);
    rebuilt.sign(kp);
    return rebuilt;
  }

  private extractFailureDetails(
    getResult: rpc.Api.GetTransactionResponse,
    label: string,
  ): string {
    let details = `[${label}] Transaction failed: ${getResult.status}`;
    try {
      const failed = getResult as rpc.Api.GetFailedTransactionResponse;
      if (failed.resultXdr) {
        details += `\n  resultXdr: ${failed.resultXdr.toXDR('base64')}`;
      }
      if (failed.resultMetaXdr) {
        const meta = failed.resultMetaXdr;
        try {
          if ((meta.switch() as unknown as number) === 3) {
            const v3 = meta.v3();
            const sorobanMeta = v3.sorobanMeta() as {
              diagnosticEvents?: () => { toXDR: (f: string) => string }[];
            } | null;
            if (sorobanMeta?.diagnosticEvents) {
              for (const evt of sorobanMeta.diagnosticEvents()) {
                details += `\n  diagnostic: ${evt.toXDR('base64')}`;
              }
            }
          }
        } catch { /* not v3 or diagnostics unavailable */ }
      }
    } catch (e) {
      details += `\n  (could not extract details: ${e})`;
    }
    return details;
  }

  /**
   * Normalize a wallet signature payload to a raw 64-byte Buffer.
   * Wallets may return either raw ed25519 bytes or a full SorobanAuthorizationEntry XDR.
   */
  normalizeWalletSignature(payload: unknown): Buffer {
    let payloadStr: string;

    if (typeof payload !== 'string') {
      if (payload instanceof Uint8Array) {
        payloadStr = Buffer.from(payload).toString('utf8');
      } else if (Array.isArray(payload)) {
        payloadStr = Buffer.from(payload as number[]).toString('utf8');
      } else if (payload && typeof payload === 'object') {
        const obj = payload as Record<string, unknown>;
        const nested = obj.signedAuthEntry ?? obj.signature ?? null;
        if (typeof nested === 'string') {
          payloadStr = nested;
        } else {
          throw new Error('Signature payload is not a string');
        }
      } else {
        throw new Error('Signature payload is empty');
      }
    } else {
      payloadStr = payload;
    }

    const raw = Buffer.from(payloadStr, 'base64');
    if (raw.length === 64) return raw;

    // Double-encoded base64 (some wallets encode the base64 text as bytes)
    const maybeAscii = raw.toString('utf8');
    if (/^[A-Za-z0-9+/=]+$/.test(maybeAscii)) {
      const secondPass = Buffer.from(maybeAscii, 'base64');
      if (secondPass.length === 64) return secondPass;
    }

    // Full SorobanAuthorizationEntry XDR
    try {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(payloadStr, 'base64');
      const creds = entry.credentials();
      if (creds.switch().name !== 'sorobanCredentialsAddress') {
        throw new Error(`Unexpected credential type: ${creds.switch().name}`);
      }
      const sigVec = creds.address().signature().vec();
      if (!sigVec?.length) {
        throw new Error('Signed auth entry contains empty signature vector');
      }
      const sigMap = sigVec[0]!.map();
      if (!sigMap) throw new Error('Signature item is not a map');
      for (const item of sigMap) {
        if (item.key().sym().toString() === 'signature') {
          const bytes = Buffer.from(item.val().bytes());
          if (bytes.length !== 64) {
            throw new Error(`Signature length ${bytes.length}, expected 64`);
          }
          return bytes;
        }
      }
      throw new Error("No 'signature' field in signed auth entry");
    } catch (err) {
      throw new Error(
        `Unsupported wallet signature format (decoded bytes: ${raw.length}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
