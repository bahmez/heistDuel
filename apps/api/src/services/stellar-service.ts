import {
  Keypair,
  rpc,
  xdr,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { HeistContractClient, NETWORK_PASSPHRASE } from "@repo/stellar";

const rpcUrl = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const contractId = process.env.HEIST_CONTRACT_ID || "";
const verifierContractId = process.env.ZK_VERIFIER_CONTRACT_ID || "";

let sourceKeypair: Keypair | null = null;
let client: HeistContractClient | null = null;

export function initStellar(): void {
  const secret = process.env.SOURCE_SECRET;
  if (!secret) {
    console.warn(
      "WARNING: SOURCE_SECRET not set. Multi-auth transactions will fail. " +
        "Generate a testnet keypair and fund via friendbot.",
    );
    sourceKeypair = Keypair.random();
    console.log(`Generated temp keypair: ${sourceKeypair.publicKey()}`);
    console.log(
      `Fund it: https://friendbot.stellar.org/?addr=${sourceKeypair.publicKey()}`,
    );
  } else {
    sourceKeypair = Keypair.fromSecret(secret);
  }

  client = new HeistContractClient(contractId, rpcUrl);
  console.log(`Stellar service initialized. Source: ${sourceKeypair.publicKey()}`);
}

export function getSourceKeypair(): Keypair {
  if (!sourceKeypair) throw new Error("Stellar service not initialized");
  return sourceKeypair;
}

export function getSourceAddress(): string {
  return getSourceKeypair().publicKey();
}

export function getClient(): HeistContractClient {
  if (!client) throw new Error("Stellar service not initialized");
  return client;
}

export function getRpcUrl(): string {
  return rpcUrl;
}

export function getVerifierContractId(): string {
  return verifierContractId;
}

/**
 * Sign a transaction XDR with the backend source keypair and submit.
 * Clears any extra envelope signatures so only the source account signs the
 * envelope.  Soroban auth entry signatures inside operations are preserved.
 *
 * Submission strategy:
 *  - TRY_AGAIN_LATER: the tx was NOT submitted to the network — safe to
 *    retry with a delay (unlike PENDING, no BAD_SEQ risk). Retried up to
 *    TRY_AGAIN_MAX_RETRIES times.
 *  - PENDING: poll getTransaction for up to 120s.
 *  - NEVER re-submit after PENDING (would cause txBAD_SEQ if the first tx
 *    was included but the RPC node was slow to index it).
 *  - If still NOT_FOUND after 120s AND the tx sequence matches exactly,
 *    treat as success (tx included but RPC lagged).
 */
export interface SubmitResult {
  hash: string;
  /** true when the tx was confirmed via account-sequence heuristic instead of getTransaction */
  confirmedViaSequence: boolean;
}

const TRY_AGAIN_MAX_RETRIES = 8;
const TRY_AGAIN_DELAY_MS = 5_000;

export async function signAndSubmit(txXdr: string, label = "tx"): Promise<SubmitResult> {
  const kp = getSourceKeypair();
  const server = new rpc.Server(rpcUrl);

  // Fetch the source account sequence BEFORE signing. This is the sequence
  // number the transaction will consume if it succeeds.
  const accountBefore = await server.getAccount(kp.publicKey());
  const seqBefore = BigInt(accountBefore.sequenceNumber());
  // The tx will set the account sequence to seqBefore+1 when it is included.
  const expectedSeqAfter = seqBefore + 1n;

  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
  tx.signatures.splice(0);
  tx.sign(kp);

  // ── Submit, retrying on TRY_AGAIN_LATER ──────────────────────────────────
  // TRY_AGAIN_LATER means the node is congested and rejected the tx *before*
  // forwarding it to the network. The tx sequence has NOT been consumed, so
  // resending the same signed tx is safe.
  let sendResult: rpc.Api.SendTransactionResponse | null = null;
  for (let attempt = 0; attempt <= TRY_AGAIN_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[${label}] TRY_AGAIN_LATER — waiting ${TRY_AGAIN_DELAY_MS / 1000}s before retry (attempt ${attempt}/${TRY_AGAIN_MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, TRY_AGAIN_DELAY_MS));
    }
    sendResult = await server.sendTransaction(tx);
    console.log(`[${label}] send status=${sendResult.status} hash=${sendResult.hash}`);
    if (sendResult.status !== "TRY_AGAIN_LATER") break;
  }
  if (!sendResult) throw new Error("sendTransaction never attempted");

  if (sendResult.status === "ERROR") {
    throw new Error(
      `Send failed: ${sendResult.errorResult?.toXDR("base64") ?? "unknown"}`,
    );
  }
  if (sendResult.status === "TRY_AGAIN_LATER") {
    throw new Error(`Send failed: still TRY_AGAIN_LATER after ${TRY_AGAIN_MAX_RETRIES} retries`);
  }

  // ── Poll getTransaction ───────────────────────────────────────────────────
  const maxWaitMs = 120_000;
  const pollInterval = 3_000;
  const start = Date.now();
  let getResult = await server.getTransaction(sendResult.hash);

  while (getResult.status === "NOT_FOUND" && Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollInterval));
    getResult = await server.getTransaction(sendResult.hash);
  }

  if (getResult.status === "SUCCESS") {
    return { hash: sendResult.hash, confirmedViaSequence: false };
  }

  // ── Sequence-advance heuristic ────────────────────────────────────────────
  // If getTransaction still returns NOT_FOUND after 120s, check whether the
  // account sequence advanced to EXACTLY the expected value. This proves *this*
  // transaction (and only this one) was included while the RPC lagged.
  if (getResult.status === "NOT_FOUND") {
    const accountAfter = await server.getAccount(kp.publicKey());
    const seqAfter = BigInt(accountAfter.sequenceNumber());

    if (seqAfter === expectedSeqAfter) {
      console.warn(
        `[${label}] getTransaction returned NOT_FOUND but account sequence ` +
          `advanced exactly as expected (${seqBefore} → ${seqAfter}). Treating as success.`,
      );
      return { hash: sendResult.hash, confirmedViaSequence: true };
    }

    // Sequence didn't advance by exactly 1 — something else happened or the
    // tx was never included.
    throw new Error(
      `[${label}] Transaction NOT_FOUND after ${maxWaitMs / 1000}s and sequence ` +
        `${seqBefore} → ${seqAfter} (expected ${expectedSeqAfter}). ` +
        `hash: ${sendResult.hash}`,
    );
  }

  // Extract detailed failure info for Soroban transactions
  let details = `Transaction failed: ${getResult.status}`;
  try {
    const failed = getResult as rpc.Api.GetFailedTransactionResponse;
    if (failed.resultXdr) {
      details += `\n  resultXdr: ${failed.resultXdr.toXDR("base64")}`;
      const txResult = failed.resultXdr;
      const results = txResult.result().results();
      for (const opResult of results) {
        const tr = opResult.tr();
        if (tr) {
          details += `\n  opResult type: ${tr.switch().name}`;
        }
      }
    }
    if (failed.resultMetaXdr) {
      const meta = failed.resultMetaXdr;
      const version = meta.switch();
      details += `\n  metaVersion: ${version}`;
      let sorobanMeta = null;
      try {
        if (version === 3) sorobanMeta = meta.v3().sorobanMeta();
      } catch { /* not v3 */ }
      if (!sorobanMeta) {
        try {
          const raw = meta.value();
          if (raw && typeof raw === "object" && "sorobanMeta" in raw) {
            sorobanMeta = (raw as { sorobanMeta: () => unknown }).sorobanMeta();
          }
        } catch { /* fallback failed */ }
      }
      if (sorobanMeta && typeof sorobanMeta === "object") {
        try {
          const diagEvents = (sorobanMeta as { diagnosticEvents: () => { toXDR: (fmt: string) => string }[] }).diagnosticEvents();
          if (diagEvents) {
            for (const evt of diagEvents) {
              details += `\n  diagnostic: ${evt.toXDR("base64")}`;
            }
          }
        } catch { /* no diagnostic events */ }
      }
    }
  } catch (e) {
    details += `\n  (could not extract details: ${e})`;
  }
  console.error(details);
  throw new Error(details);
}
