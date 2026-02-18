import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  Keypair,
  rpc,
  xdr,
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

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    // ConfigService.onModuleInit() has already run at this point because
    // StellarModule imports ConfigModule, establishing the dependency order.
    this.rpcUrl = this.configService.get('rpcUrl');
    this.contractId = this.configService.get('heistContractId');
    this.verifierContractId = this.configService.get('zkVerifierContractId');

    if (!this.rpcUrl) {
      throw new Error('Missing Soroban RPC URL at startup (rpcUrl).');
    }

    const secret = process.env.SOURCE_SECRET;

    if (!secret) {
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

    this.client = new HeistContractClient(this.contractId, this.rpcUrl);

    if (!this.contractId) {
      this.logger.error(
        'Heist contract ID is empty at startup. ' +
          'Gameplay endpoints will fail until config is fixed. ' +
          'Check /api/config/public and ConfigService logs.',
      );
    }

    this.logger.log(
      `Stellar service ready — source: ${this.sourceKeypair.publicKey()} ` +
        `contract: ${this.contractId ? `${this.contractId.slice(0, 8)}…` : '(unset)'}`,
    );
  }

  getSourceKeypair(): Keypair {
    return this.sourceKeypair;
  }

  getSourceAddress(): string {
    return this.sourceKeypair.publicKey();
  }

  getClient(): HeistContractClient {
    return this.client;
  }

  getRpcUrl(): string {
    return this.rpcUrl;
  }

  getVerifierContractId(): string {
    return this.verifierContractId;
  }

  /**
   * Sign a transaction XDR with the backend keypair and submit it to the network.
   *
   * Strategy:
   * - Retry on TRY_AGAIN_LATER (tx not forwarded yet — safe to resend).
   * - Poll getTransaction for up to 120 s.
   * - Fall back to account-sequence heuristic if still NOT_FOUND after polling.
   */
  async signAndSubmit(txXdr: string, label = 'tx'): Promise<SubmitResult> {
    const kp = this.sourceKeypair;
    const server = new rpc.Server(this.rpcUrl);

    const accountBefore = await server.getAccount(kp.publicKey());
    const seqBefore = BigInt(accountBefore.sequenceNumber());
    const expectedSeqAfter = seqBefore + 1n;

    const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
    tx.signatures.splice(0);
    tx.sign(kp);

    // Submit with TRY_AGAIN_LATER retries
    let sendResult: rpc.Api.SendTransactionResponse | null = null;
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

    if (sendResult.status === 'ERROR') {
      throw new Error(
        `Send failed: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`,
      );
    }
    if (sendResult.status === 'TRY_AGAIN_LATER') {
      throw new Error(
        `Send failed: still TRY_AGAIN_LATER after ${TRY_AGAIN_MAX_RETRIES} retries`,
      );
    }

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
            `advanced exactly as expected (${seqBefore} → ${seqAfter}). Treating as success.`,
        );
        return { hash: sendResult.hash, confirmedViaSequence: true };
      }

      throw new Error(
        `[${label}] Transaction NOT_FOUND after ${MAX_POLL_WAIT_MS / 1000}s ` +
          `and sequence ${seqBefore} → ${seqAfter} (expected ${expectedSeqAfter}). ` +
          `hash: ${sendResult.hash}`,
      );
    }

    // Extract Soroban diagnostic info from failed tx
    const details = this.extractFailureDetails(getResult, label);
    this.logger.error(details);
    throw new Error(details);
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
