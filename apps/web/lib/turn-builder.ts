import {
  HeistContractClient,
  buildMockProof,
  countLootInDelta,
  computeScoreDelta,
  zeroBitset,
  CAMERA_PENALTY,
  LASER_PENALTY,
  type Position,
  type TurnPublic,
  type PlayerGameView,
} from "@repo/stellar";
import { getRuntimeConfig } from "./runtime-config";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

/** Human-readable path string for logs, e.g. "(2,3)→(3,3)→(4,3)". */
function formatPath(path: Position[]): string {
  return path.map((p) => `(${p.x},${p.y})`).join("→");
}

/** Score breakdown returned alongside the built turn for UI display. */
export interface TurnBreakdown {
  turnIndex: number;
  player: string;
  noPathFlag: boolean;
  path: Position[];
  lootItems: number;
  cameraHits: number;
  laserHits: number;
  /** Positive = points gained, negative = points lost. */
  scoreDelta: bigint;
  /** Score of MY player before this turn (from the view). */
  scoreBefore: bigint;
}

/**
 * Build a complete TurnPublic, mock proof, and submit_turn transaction.
 * Logs a detailed breakdown to the browser console under a collapsible group.
 */
export async function buildTurn(
  playerAddress: string,
  sessionId: number,
  view: PlayerGameView,
  roll: number,
  path: Position[],
  vkHash: Uint8Array,
): Promise<{
  turn: TurnPublic;
  proofBlob: Uint8Array;
  txXdr: string;
  authInfos: import('@repo/stellar').AuthEntryInfo[];
  breakdown: TurnBreakdown;
}> {
  const cfg = await getRuntimeConfig();
  const client = new HeistContractClient(cfg.heistContractId, cfg.rpcUrl || RPC_URL);
  const isPlayer1 = playerAddress === view.player1;
  const startPos = isPlayer1 ? view.player1Pos : view.player2Pos;
  const scoreBefore = isPlayer1 ? view.player1Score : view.player2Score;
  const noPathFlag = path.length <= 1 && path[0]?.x === startPos.x && path[0]?.y === startPos.y;

  let lootDelta: Uint8Array;
  let cameraHits: number;
  let laserHits: number;
  let scoreDelta: bigint;
  let endPos: Position;
  let fullPath: Position[];

  if (noPathFlag) {
    lootDelta = zeroBitset();
    cameraHits = 0;
    laserHits = 0;
    scoreDelta = 0n;
    endPos = startPos;
    fullPath = [startPos];
  } else {
    fullPath = path;
    endPos = fullPath[fullPath.length - 1]!;
    // Fetch loot delta AND hazard hits directly from the contract so we always
    // use the current on-chain state — never a stale cached view.
    // • getPathLootDelta: avoids LootAlreadyCollected when loot_collected is stale
    // • getPathHazards:   covers cameras whose radius reaches the path from outside the fog
    const [contractLootDelta, hazards] = await Promise.all([
      client.getPathLootDelta(playerAddress, sessionId, fullPath),
      client.getPathHazards(playerAddress, sessionId, fullPath),
    ]);
    lootDelta = contractLootDelta;
    const lootPoints = countLootInDelta(lootDelta);
    cameraHits = hazards.cameraHits;
    laserHits = hazards.laserHits;
    scoreDelta = computeScoreDelta(lootPoints, cameraHits, laserHits);
  }

  const lootItems = countLootInDelta(lootDelta);

  // ─── Score breakdown log ──────────────────────────────────────────────────
  const sign = (n: bigint) => (n >= 0n ? `+${n}` : `${n}`);
  const lootPts = BigInt(lootItems);
  const camPts = BigInt(cameraHits) * CAMERA_PENALTY;
  const laserPts = BigInt(laserHits) * LASER_PENALTY;

  console.group(
    `%c[Turn #${view.turnIndex}] ${playerAddress.slice(0, 6)}… — roll ${roll} — score ${sign(scoreDelta)} pts`,
    scoreDelta >= 0n
      ? "color:#4ade80;font-weight:bold"
      : "color:#f87171;font-weight:bold",
  );
  if (noPathFlag) {
    console.log("%cNo move (skip turn) — score unchanged", "color:#9ca3af");
  } else {
    console.log(`Path (${fullPath.length} steps): ${formatPath(fullPath)}`);
    console.log(
      `Loot:    ${lootItems} item(s) collected  →  %c${sign(lootPts)} pt(s)`,
      "color:#fbbf24;font-weight:bold",
    );
    console.log(
      `Cameras: ${cameraHits} hit(s)  (penalty ${CAMERA_PENALTY}/hit)  →  %c-${camPts} pt(s)`,
      cameraHits > 0 ? "color:#f87171;font-weight:bold" : "color:#9ca3af",
    );
    console.log(
      `Lasers:  ${laserHits} hit(s)  (penalty ${LASER_PENALTY}/hit)  →  %c-${laserPts} pt(s)`,
      laserHits > 0 ? "color:#f87171;font-weight:bold" : "color:#9ca3af",
    );
    console.log(
      `Formula: ${lootPts} loot - ${camPts} cameras - ${laserPts} lasers = %c${sign(scoreDelta)} pts`,
      scoreDelta >= 0n ? "color:#4ade80;font-weight:bold" : "color:#f87171;font-weight:bold",
    );
  }
  console.log(`Score before: ${scoreBefore}  →  estimated after: ${scoreBefore + scoreDelta}`);
  console.groupEnd();
  // ─────────────────────────────────────────────────────────────────────────

  const stateHashBefore = await client.getStateHash(playerAddress, sessionId);

  const partialTurn: TurnPublic = {
    sessionId,
    turnIndex: view.turnIndex,
    player: playerAddress,
    startPos,
    endPos,
    rolledValue: roll,
    scoreDelta,
    cameraHits,
    laserHits,
    lootCollectedMaskDelta: lootDelta,
    noPathFlag,
    stateHashBefore,
    stateHashAfter: new Uint8Array(32),
    path: fullPath,
  };

  const stateHashAfter = await client.simulateStateHashAfter(
    playerAddress,
    sessionId,
    partialTurn,
  );

  const finalTurn: TurnPublic = {
    ...partialTurn,
    stateHashAfter,
  };

  const publicInputsHash = await client.hashTurnPublic(
    playerAddress,
    finalTurn,
  );

  const proofBlob = buildMockProof(vkHash, publicInputsHash);

  const { txXdr, authInfos } = await client.buildSubmitTurnTx(
    playerAddress,
    sessionId,
    playerAddress,
    proofBlob,
    finalTurn,
  );

  const breakdown: TurnBreakdown = {
    turnIndex: view.turnIndex,
    player: playerAddress,
    noPathFlag,
    path: fullPath,
    lootItems,
    cameraHits,
    laserHits,
    scoreDelta,
    scoreBefore,
  };

  return { turn: finalTurn, proofBlob, txXdr, authInfos, breakdown };
}
