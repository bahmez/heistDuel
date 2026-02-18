import type { Server as SocketServer } from "socket.io";
import { authorizeEntry, xdr } from "@stellar/stellar-sdk";
import { getLobby, updateLobby } from "./lobby-store.js";
import {
  getClient,
  getSourceAddress,
  signAndSubmit,
  type SubmitResult,
} from "./stellar-service.js";
import { HeistContractClient, NETWORK_PASSPHRASE, type AuthEntryInfo } from "@repo/stellar";

/**
 * Resolvers for pending signature requests.
 * When the frontend signs a preimage and sends it back, the resolver is called
 * to unblock the backend's `authorizeEntry` call.
 * Key format: `${gameId}:${purpose}:${playerAddress}`
 */
const sigResolvers = new Map<
  string,
  { resolve: (sig: Buffer) => void; reject: (err: Error) => void }
>();

const SIGN_TIMEOUT_MS = 120_000;
const SIM_RETRY_ATTEMPTS = 8;
const SIM_RETRY_DELAY_MS = 2_000;

/** Extra budget for retries that follow a sequence-fallback confirmation */
const SIM_RETRY_ATTEMPTS_EXTENDED = 25;
const SIM_RETRY_DELAY_MS_EXTENDED = 5_000;

/** Delay after a tx was confirmed via the sequence heuristic, to let the RPC catch up */
const POST_SEQ_FALLBACK_DELAY_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableSimulationError(msg: string): boolean {
  // Contract errors that can appear transiently right after a previous tx
  // because RPC nodes may lag on state visibility.
  return (
    msg.includes("Error(Contract, #1)") || // GameNotFound
    msg.includes("Error(Contract, #7)") || // SeedsNotReady
    msg.includes("Error(Contract, #17)") // InvalidStatus
  );
}

async function withSimulationRetry<T>(
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
      if (!isRetriableSimulationError(msg) || attempt === maxAttempts) {
        throw err;
      }
      console.warn(
        `[${label}] simulation not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Wallets may return either:
 * - raw ed25519 signature (base64, 64 bytes decoded), or
 * - a full signed SorobanAuthorizationEntry XDR.
 * Normalize to raw 64-byte signature for authorizeEntry().
 */
function normalizeWalletSignature(payload: unknown): Buffer {
  let payloadStr: string;

  if (typeof payload !== "string") {
    if (payload instanceof Uint8Array) {
      payloadStr = Buffer.from(payload).toString("utf8");
    } else if (Array.isArray(payload)) {
      payloadStr = Buffer.from(payload).toString("utf8");
    } else if (payload && typeof payload === "object") {
      const obj = payload as Record<string, unknown>;
      const nested = obj.signedAuthEntry ?? obj.signature ?? null;
      if (typeof nested === "string") {
        payloadStr = nested;
      } else {
        throw new Error("Signature payload is not a string");
      }
    } else {
      throw new Error("Signature payload is empty");
    }
  } else {
    payloadStr = payload;
  }

  // First attempt: direct base64 decode to raw signature bytes.
  const raw = Buffer.from(payloadStr, "base64");
  if (raw.length === 64) {
    return raw;
  }

  // Some clients send bytes of the base64 text itself. Decode that as UTF-8 first.
  const maybeAscii = raw.toString("utf8");
  if (/^[A-Za-z0-9+/=]+$/.test(maybeAscii)) {
    const secondPass = Buffer.from(maybeAscii, "base64");
    if (secondPass.length === 64) {
      return secondPass;
    }
  }

  try {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(payloadStr, "base64");
    const creds = entry.credentials();
    if (creds.switch().name !== "sorobanCredentialsAddress") {
      throw new Error(`Unexpected credential type: ${creds.switch().name}`);
    }

    const sigVal = creds.address().signature();
    const sigVec = sigVal.vec();
    if (!sigVec || sigVec.length === 0) {
      throw new Error("Signed auth entry contains empty signature vector");
    }

    const firstSig = sigVec[0]!;
    const sigMap = firstSig.map();
    if (!sigMap) {
      throw new Error("Signed auth entry signature item is not a map");
    }

    for (const item of sigMap) {
      const key = item.key().sym().toString();
      if (key === "signature") {
        const sigBytes = Buffer.from(item.val().bytes());
        if (sigBytes.length !== 64) {
          throw new Error(
            `Extracted signature length ${sigBytes.length}, expected 64`,
          );
        }
        return sigBytes;
      }
    }

    throw new Error("No 'signature' field found in signed auth entry");
  } catch (err) {
    throw new Error(
      `Unsupported wallet signature payload format (decoded bytes: ${raw.length}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function initGameCoordinator(io: SocketServer): void {
  io.on("connection", (socket) => {
    socket.on("join_lobby", (gameId: string) => {
      socket.join(`game:${gameId}`);
      const lobby = getLobby(gameId);
      if (lobby) {
        socket.emit("lobby_state", lobby);
      }
    });

    socket.on(
      "auth_signature",
      (data: {
        gameId: string;
        playerAddress: string;
        purpose: string;
        signatureBase64: string;
      }) => {
        const key = `${data.gameId}:${data.purpose}:${data.playerAddress}`;
        const pending = sigResolvers.get(key);
        if (pending) {
          console.log(
            `[${data.purpose}] Received signature from ${data.playerAddress}`,
          );
          sigResolvers.delete(key);
          try {
            const normalized = normalizeWalletSignature(data.signatureBase64);
            console.log(
              `[${data.purpose}] Normalized signature length: ${normalized.length}`,
            );
            pending.resolve(normalized);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            pending.reject(new Error(msg));
          }
        } else {
          console.warn(`No pending resolver for key: ${key}`);
        }
      },
    );
  });
}

/**
 * Sign a single auth entry by coordinating with a player's wallet via socket.
 * Uses `authorizeEntry` from the SDK on the backend (Node.js) where Buffer
 * works correctly, avoiding browser polyfill issues.
 *
 * The signer callback sends the preimage to the frontend and waits for the
 * wallet to sign it and send back the raw ed25519 signature.
 */
async function signAuthEntryRemotely(
  io: SocketServer,
  gameId: string,
  purpose: string,
  authEntry: xdr.SorobanAuthorizationEntry,
  playerAddress: string,
  expirationLedger: number,
): Promise<xdr.SorobanAuthorizationEntry> {
  return authorizeEntry(
    authEntry,
    async (preimage) => {
      const key = `${gameId}:${purpose}:${playerAddress}`;

      return new Promise<Buffer>((resolve, reject) => {
        const timeout = setTimeout(() => {
          sigResolvers.delete(key);
          reject(new Error(`Signature timeout for ${playerAddress} (${purpose})`));
        }, SIGN_TIMEOUT_MS);

        sigResolvers.set(key, {
          resolve: (sig: Buffer) => {
            clearTimeout(timeout);
            resolve(sig);
          },
          reject: (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          },
        });

        console.log(
          `[${purpose}] Sending preimage to ${playerAddress} for signing`,
        );
        io.to(`game:${gameId}`).emit("sign_auth_entry", {
          gameId,
          purpose,
          targetPlayer: playerAddress,
          preimageXdr: preimage.toXDR("base64"),
        });
      });
    },
    expirationLedger,
    NETWORK_PASSPHRASE,
  );
}

/**
 * Sign all auth entries for a transaction and submit it.
 */
async function signAllAndSubmit(
  io: SocketServer,
  gameId: string,
  purpose: string,
  txXdr: string,
  authInfos: AuthEntryInfo[],
): Promise<SubmitResult> {
  if (authInfos.length === 0) {
    return signAndSubmit(txXdr, purpose);
  }

  const signedEntries = await Promise.all(
    authInfos.map(async (info) => {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(
        info.authEntryXdr,
        "base64",
      );
      const signedEntry = await signAuthEntryRemotely(
        io,
        gameId,
        purpose,
        entry,
        info.address,
        info.expirationLedger,
      );
      return { index: info.index, signedEntry };
    }),
  );

  let finalTxXdr = txXdr;
  for (const { index, signedEntry } of signedEntries) {
    finalTxXdr = HeistContractClient.replaceAuthEntry(
      finalTxXdr,
      index,
      signedEntry.toXDR("base64"),
    );
  }

  return signAndSubmit(finalTxXdr, purpose);
}

/**
 * Start the game setup flow after both players have joined.
 */
export async function initiateStartGame(
  io: SocketServer,
  gameId: string,
): Promise<void> {
  const lobby = getLobby(gameId);
  if (!lobby || !lobby.player2 || !lobby.player2SeedCommit) {
    throw new Error("Lobby not ready");
  }

  updateLobby(gameId, { phase: "starting" });
  io.to(`game:${gameId}`).emit("lobby_state", getLobby(gameId));

  const client = getClient();
  const source = getSourceAddress();

  const p1Commit = hexToBytes(lobby.player1SeedCommit);
  const p2Commit = hexToBytes(lobby.player2SeedCommit);

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

    console.log(
      `[start_game] Built tx with ${authInfos.length} auth entries`,
    );

    const result = await signAllAndSubmit(
      io,
      gameId,
      "start_game",
      txXdr,
      authInfos,
    );
    console.log(`start_game tx confirmed: ${result.hash}`);

    await handlePostStartGame(io, gameId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("start_game failed:", msg);
    updateLobby(gameId, { phase: "error", error: msg });
    io.to(`game:${gameId}`).emit("lobby_state", getLobby(gameId));
    io.to(`game:${gameId}`).emit("tx_error", {
      purpose: "start_game",
      error: msg,
    });
  }
}

/**
 * After start_game confirms, initiate seed reveals.
 * Each reveal only needs one player's signature.
 */
async function handlePostStartGame(
  io: SocketServer,
  gameId: string,
): Promise<void> {
  updateLobby(gameId, { phase: "revealing" });
  io.to(`game:${gameId}`).emit("lobby_state", getLobby(gameId));

  const lobby = getLobby(gameId);
  if (!lobby || !lobby.player1SeedSecret || !lobby.player2SeedSecret) {
    throw new Error("Seeds not available for reveal");
  }

  const client = getClient();
  const source = getSourceAddress();

  // IMPORTANT:
  // These txs use the same source account, so they must be built/submitted
  // sequentially to avoid sequence-number collisions.
  let anySeqFallback = false;

  const r1 = await withSimulationRetry("reveal_seed_p1_build", () =>
    client.buildRevealSeedTx(
      source,
      lobby.sessionId,
      lobby.player1,
      hexToBytes(lobby.player1SeedSecret!),
    ),
  );
  const res1 = await signAllAndSubmit(
    io,
    gameId,
    "reveal_seed_p1",
    r1.txXdr,
    r1.authInfos,
  );
  console.log(`reveal_seed_p1 confirmed: ${res1.hash}`);
  if (res1.confirmedViaSequence) anySeqFallback = true;

  const r2 = await withSimulationRetry("reveal_seed_p2_build", () =>
    client.buildRevealSeedTx(
      source,
      lobby.sessionId,
      lobby.player2!,
      hexToBytes(lobby.player2SeedSecret!),
    ),
  );
  const res2 = await signAllAndSubmit(
    io,
    gameId,
    "reveal_seed_p2",
    r2.txXdr,
    r2.authInfos,
  );
  console.log(`reveal_seed_p2 confirmed: ${res2.hash}`);
  if (res2.confirmedViaSequence) anySeqFallback = true;

  // When any reveal was confirmed via the sequence heuristic, the RPC node
  // hasn't indexed the result yet. Give it extra time before simulating
  // begin_match, which depends on the on-chain seeds being visible.
  if (anySeqFallback) {
    console.log(
      `[post-reveal] Waiting ${POST_SEQ_FALLBACK_DELAY_MS / 1000}s for RPC to catch up after sequence-fallback confirmation...`,
    );
    await sleep(POST_SEQ_FALLBACK_DELAY_MS);
  }

  await handlePostRevealSeed(io, gameId, anySeqFallback);
}

/**
 * Initiate begin_match after both seeds are revealed.
 */
async function handlePostRevealSeed(
  io: SocketServer,
  gameId: string,
  useExtendedRetry = false,
): Promise<void> {
  updateLobby(gameId, { phase: "beginning" });
  io.to(`game:${gameId}`).emit("lobby_state", getLobby(gameId));

  const client = getClient();
  const source = getSourceAddress();
  const lobby = getLobby(gameId);
  if (!lobby) throw new Error("Lobby not found");

  const retryOpts = useExtendedRetry
    ? { maxAttempts: SIM_RETRY_ATTEMPTS_EXTENDED, delayMs: SIM_RETRY_DELAY_MS_EXTENDED }
    : undefined;

  try {
    const { txXdr, authInfos } = await withSimulationRetry(
      "begin_match_build",
      () => client.buildBeginMatchTx(source, lobby.sessionId),
      retryOpts,
    );

    const bmResult = await signAllAndSubmit(
      io,
      gameId,
      "begin_match",
      txXdr,
      authInfos,
    );
    console.log(`begin_match tx confirmed: ${bmResult.hash}`);

    updateLobby(gameId, { phase: "active" });
    io.to(`game:${gameId}`).emit("game_started", { gameId });
    io.to(`game:${gameId}`).emit("lobby_state", getLobby(gameId));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("begin_match failed:", msg);
    updateLobby(gameId, { phase: "error", error: msg });
    io.to(`game:${gameId}`).emit("lobby_state", getLobby(gameId));
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
