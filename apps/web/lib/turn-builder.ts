import {
  HeistContractClient,
  buildMockProof,
  countLootInDelta,
  computeScoreDelta,
  computePosCommit,
  deriveNewPosNonce,
  computeStateCommitment,
  computeTurnPiHash,
  generateMap,
  computeLootDelta,
  computeCameraHits,
  computeLaserHits,
  zeroBitset,
  CAMERA_PENALTY,
  LASER_PENALTY,
  type Position,
  type PlayerGameView,
  type TurnPublic,
  type TurnZkPublic,
} from "@repo/stellar";
import { getRuntimeConfig } from "./runtime-config";
import { usePrivateStore } from "../stores/private-store";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

/** Encode a signed i128 as 16 bytes big-endian (two's complement). */
function i128ToBytes(v: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let bits = v < 0n ? v + (1n << 128n) : v;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  return out;
}

/** Human-readable path string for logs, e.g. "(2,3)→(3,3)→(4,3)". */
function formatPath(path: Position[]): string {
  return path.map((p) => `(${p.x},${p.y})`).join("→");
}

/**
 * Build a 292-byte mock proof blob matching the Groth16 zk-verifier format.
 *   [0..4]   n_pub  = 1 (u32 BE)
 *   [4..36]  pi_hash (the real hash value — verifier reads it from here)
 *   [36..292] dummy zeros (A, B, C points — pairing will fail but OK for dev)
 */
function buildMockProofBlob(piHashBytes: Uint8Array): Uint8Array {
  const blob = new Uint8Array(292);
  blob[3] = 1; // n_pub = 1 (big-endian u32)
  blob.set(piHashBytes.slice(0, 32), 4);
  return blob;
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Score breakdown returned alongside the built turn for UI display. */
export interface TurnBreakdown {
  turnIndex: number;
  player: string;
  noPathFlag: boolean;
  exitedFlag: boolean;
  path: Position[];
  lootItems: number;
  cameraHits: number;
  laserHits: number;
  /** Positive = points gained, negative = points lost. */
  scoreDelta: bigint;
  /** Score of MY player before this turn (from the view). */
  scoreBefore: bigint;
}

// ─── ZK proof generation ─────────────────────────────────────────────────────

/**
 * Call the backend /api/proof/prove endpoint to generate a Groth16 proof.
 * Returns the 292-byte proof blob as Uint8Array.
 *
 * Falls back to a mock blob if the endpoint is unavailable (dev mode).
 */
async function generateRealProof(
  inputs: Record<string, unknown>,
  piHashBytes: Uint8Array,
): Promise<Uint8Array> {
  try {
    const res = await fetch(`${API_URL}/api/proof/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputs),
      // Groth16 proof generation takes ~1–5 seconds.
      signal: AbortSignal.timeout(2 * 60 * 1000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
      throw new Error(`Proof backend error: ${err.error ?? res.statusText}`);
    }

    const data = await res.json() as { proofBlobHex?: string };
    if (!data.proofBlobHex) throw new Error("No proofBlobHex in proof response");

    return hexToBytes(data.proofBlobHex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("fetch") || msg.includes("network") || msg.includes("connect")) {
      console.warn("[proof] Backend unavailable — using mock proof blob (dev mode)");
      return buildMockProofBlob(piHashBytes);
    }
    throw err;
  }
}

// ─── Main build function ──────────────────────────────────────────────────────

/**
 * Build a complete turn: compute ZK inputs, generate proof (real or mock),
 * and build the submit_turn transaction.
 */
export async function buildTurn(
  playerAddress: string,
  sessionId: number,
  gameId: string,
  view: PlayerGameView,
  roll: number,
  path: Position[],
  vkHash: Uint8Array,
): Promise<{
  turn: TurnPublic;
  proofBlob: Uint8Array;
  txXdr: string;
  authInfos: import("@repo/stellar").AuthEntryInfo[];
  breakdown: TurnBreakdown;
  /** New position nonce hex — caller must persist via advancePosNonce after tx confirms. */
  newPosNonceHex: string;
}> {
  const cfg = await getRuntimeConfig();
  const client = new HeistContractClient(cfg.heistContractId, cfg.rpcUrl || RPC_URL);

  const isPlayer1 = playerAddress === view.player1;
  const startPos  = isPlayer1 ? view.player1Pos : view.player2Pos;
  const scoreBefore = isPlayer1 ? view.player1Score : view.player2Score;
  const playerTag   = isPlayer1 ? 1 : 2;

  // ─── Path normalization ─────────────────────────────────────────────────────
  const noPathFlag =
    path.length <= 1 &&
    path[0]?.x === startPos.x &&
    path[0]?.y === startPos.y;

  let lootDelta:  Uint8Array;
  let cameraHits: number;
  let laserHits:  number;
  let scoreDelta: bigint;
  let endPos:     Position;
  let fullPath:   Position[];

  if (noPathFlag) {
    lootDelta  = zeroBitset();
    cameraHits = 0;
    laserHits  = 0;
    scoreDelta = 0n;
    endPos     = startPos;
    fullPath   = [startPos];
  } else {
    fullPath = path;
    endPos   = fullPath[fullPath.length - 1]!;

    // Use the global loot mask (from the contract) to compute available loot.
    // This prevents scoring loot already collected by either player, and ensures
    // lootMaskDelta won't conflict with the on-chain loot_collected_mask.
    lootDelta  = computeLootDelta(view.visibleLoot, view.lootCollectedMask, fullPath);
    cameraHits = computeCameraHits(fullPath, view.visibleCameras);
    laserHits  = computeLaserHits(fullPath, view.visibleLasers);
    scoreDelta = computeScoreDelta(countLootInDelta(lootDelta), cameraHits, laserHits);
  }

  const lootItems = countLootInDelta(lootDelta);

  // ─── Score breakdown log ────────────────────────────────────────────────────
  const sign = (n: bigint) => (n >= 0n ? `+${n}` : `${n}`);
  console.group(
    `%c[Turn #${view.turnIndex}] ${playerAddress.slice(0, 6)}… — roll ${roll} — score ${sign(scoreDelta)} pts`,
    scoreDelta >= 0n ? "color:#4ade80;font-weight:bold" : "color:#f87171;font-weight:bold",
  );
  if (noPathFlag) {
    console.log("%cNo move (skip turn) — score unchanged", "color:#9ca3af");
  } else {
    const lootPts  = BigInt(lootItems);
    const camPts   = BigInt(cameraHits) * CAMERA_PENALTY;
    const laserPts = BigInt(laserHits)  * LASER_PENALTY;
    console.log(`Path (${fullPath.length} steps): ${formatPath(fullPath)}`);
    console.log(`Loot:    ${lootItems} item(s) → %c${sign(lootPts)} pt(s)`,   "color:#fbbf24;font-weight:bold");
    console.log(`Cameras: ${cameraHits} hit(s)  → %c-${camPts} pt(s)`,        cameraHits > 0 ? "color:#f87171;font-weight:bold" : "color:#9ca3af");
    console.log(`Lasers:  ${laserHits} hit(s)   → %c-${laserPts} pt(s)`,      laserHits  > 0 ? "color:#f87171;font-weight:bold" : "color:#9ca3af");
    console.log(`Formula: ${lootPts} - ${camPts} - ${laserPts} = %c${sign(scoreDelta)} pts`,
      scoreDelta >= 0n ? "color:#4ade80;font-weight:bold" : "color:#f87171;font-weight:bold");
  }
  console.log(`Score before: ${scoreBefore}  →  estimated after: ${scoreBefore + scoreDelta}`);
  console.groupEnd();

  // ─── Private context ────────────────────────────────────────────────────────
  const priv = usePrivateStore.getState();
  if (priv.gameId !== gameId) {
    throw new Error(
      "Private game context mismatch for this tab. Please reload this game page.",
    );
  }
  if (!priv.posNonce) {
    throw new Error("Position nonce not initialised. Please complete the lobby setup.");
  }
  if (!priv.sessionSeed) {
    throw new Error("Session seed not available. Please complete the lobby setup.");
  }

  const posNonceBytes    = hexToBytes(priv.posNonce);
  const sessionSeedBytes = hexToBytes(priv.sessionSeed);

  const actualStartPos = { x: priv.posX, y: priv.posY };

  // ─── Map data (needed for exit cell and available loot) ─────────────────────
  if (!priv.mapSeed) {
    throw new Error(
      "Map seed missing. The ZK relay did not complete. " +
      "Please reload the page and wait for the relay to finish.",
    );
  }
  const mapData = generateMap(hexToBytes(priv.mapSeed));

  // ─── Exit cell detection ─────────────────────────────────────────────────────
  const exitCell = mapData.exitCell;

  // exitedFlag: player lands exactly on the exit cell this turn (and hasn't exited before).
  const exitedFlag =
    !noPathFlag &&
    !view.myExited &&
    endPos.x === exitCell.x &&
    endPos.y === exitCell.y;

  // ─── ZK commitment computation ──────────────────────────────────────────────
  const posCommitBefore = computePosCommit(actualStartPos.x, actualStartPos.y, posNonceBytes);

  // Groth16 circuit does NOT constrain new_pos_nonce derivation — any valid
  // BN254 Fr element works. deriveNewPosNonce() now returns a fresh random nonce.
  const newPosNonce    = deriveNewPosNonce(posNonceBytes, view.turnIndex);
  const posCommitAfter = computePosCommit(endPos.x, endPos.y, newPosNonce);

  // Use view.stateCommitment directly — it comes from the same state snapshot as
  // view.turnIndex, ensuring both are always consistent with each other.
  // A separate getStateCommitment() RPC call could hit a different ledger state
  // than the backend API that provided turnIndex, causing InvalidTurnData (#9).
  const stateCommitBefore = view.stateCommitment;

  const activeScore    = isPlayer1 ? view.player1Score : view.player2Score;
  const newActiveScore = activeScore + scoreDelta;

  const otherPosCommit = isPlayer1 ? view.player2PosCommit : view.player1PosCommit;
  const newP1PosCommit = isPlayer1 ? posCommitAfter : otherPosCommit;
  const newP2PosCommit = isPlayer1 ? otherPosCommit : posCommitAfter;
  const newP1Score     = isPlayer1 ? newActiveScore : view.player1Score;
  const newP2Score     = isPlayer1 ? view.player2Score : newActiveScore;

  const stateCommitAfter = computeStateCommitment(
    sessionId,
    view.turnIndex + 1,
    newP1Score,
    newP2Score,
    view.mapCommitment,
    newP1PosCommit,
    newP2PosCommit,
    sessionSeedBytes,
  );

  // ─── pi_hash (Groth16 public input) ─────────────────────────────────────────
  // Poseidon2(
  //   Poseidon4(session_id, turn_index, player_tag, pos_commit_before),
  //   Poseidon5(pos_commit_after, score_delta_fr, loot_delta, no_path_flag, exited_flag)
  // )
  const piHashBytes = computeTurnPiHash(
    sessionId,
    view.turnIndex,
    playerTag,
    posCommitBefore,
    posCommitAfter,
    scoreDelta,
    lootItems,
    noPathFlag,
    exitedFlag,
  );

  // ─── Groth16 circuit inputs ─────────────────────────────────────────────────

  // Remove already-collected loot from the map before passing to the circuit.
  // The circuit counts "loot cells along path" in map_loot, and lootDelta is the
  // count of UNCOLLECTED loot (via computeLootDelta). Passing raw mapData.loot would
  // include already-taken items and cause the circuit constraint to fail after the
  // first collected loot.
  // Use the global loot mask so the circuit receives the same availability view
  // as what was used to compute lootDelta and lootMaskDelta above.
  const availableLoot = new Uint8Array(mapData.loot.length);
  for (let i = 0; i < availableLoot.length; i++) {
    availableLoot[i] = (mapData.loot[i] ?? 0) & ~(view.lootCollectedMask[i] ?? 0);
  }

  const pathX = fullPath.map((p) => p.x);
  const pathY = fullPath.map((p) => p.y);
  while (pathX.length < 7) pathX.push(pathX[pathX.length - 1] ?? endPos.x);
  while (pathY.length < 7) pathY.push(pathY[pathY.length - 1] ?? endPos.y);
  const moveCount = Math.max(0, fullPath.length - 1);

  const proofInputs = {
    mapWalls:   bytesToHex(mapData.walls),
    mapLoot:    bytesToHex(availableLoot),
    posX:       actualStartPos.x,
    posY:       actualStartPos.y,
    posNonce:   bytesToHex(posNonceBytes),
    pathX,
    pathY,
    pathLen:    noPathFlag ? 0 : Math.min(moveCount, 6),
    newPosNonce: bytesToHex(newPosNonce),
    exitX:      exitCell.x,
    exitY:      exitCell.y,
    sessionId,
    turnIndex:  view.turnIndex,
    playerTag,
    scoreDelta: Number(scoreDelta),
    lootDelta:  lootItems,
    noPathFlag: noPathFlag ? 1 : 0,
    exitedFlag: exitedFlag ? 1 : 0,
    // Optional hints for backend logging
    posCommitBefore: bytesToHex(posCommitBefore),
    posCommitAfter:  bytesToHex(posCommitAfter),
  };

  console.log("[proof] Requesting Groth16 proof from backend...");
  const proofBlob = await generateRealProof(proofInputs, piHashBytes);
  console.log(`[proof] Proof blob: ${proofBlob.length} bytes`);

  // ─── Build on-chain turn data ───────────────────────────────────────────────
  const zkTurn: TurnZkPublic = {
    sessionId,
    turnIndex:        view.turnIndex,
    player:           playerAddress,
    scoreDelta,
    lootDelta:        lootItems,
    // Bitset of newly collected loot cells; count must equal lootDelta.
    // Contract verifies count matches and no overlap with global loot_collected_mask.
    lootMaskDelta:    lootDelta,
    posCommitBefore,
    posCommitAfter,
    stateCommitBefore,
    stateCommitAfter,
    noPathFlag,
    exitedFlag,
  };

  const { txXdr, authInfos } = await client.buildSubmitTurnTx(
    playerAddress,
    sessionId,
    playerAddress,
    proofBlob,
    zkTurn,
  );

  const finalTurn: TurnPublic = {
    ...zkTurn,
    startPos,
    endPos,
    rolledValue: roll,
    cameraHits,
    laserHits,
    lootCollectedMaskDelta: lootDelta,
    path: fullPath,
  };

  const breakdown: TurnBreakdown = {
    turnIndex:  view.turnIndex,
    player:     playerAddress,
    noPathFlag,
    exitedFlag,
    path:       fullPath,
    lootItems,
    cameraHits,
    laserHits,
    scoreDelta,
    scoreBefore,
  };

  return {
    turn:           finalTurn,
    proofBlob,
    txXdr,
    authInfos,
    breakdown,
    newPosNonceHex: bytesToHex(newPosNonce),
  };
}

// Keep for backward compatibility with any callers that pass vkHash as 3rd arg.
export { buildMockProof };
