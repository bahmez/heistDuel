import {
  HeistContractClient,
  buildMockProof,
  countLootInDelta,
  computeScoreDelta,
  zeroBitset,
  type Position,
  type TurnPublic,
  type PlayerGameView,
} from "@repo/stellar";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";
const HEIST_CONTRACT =
  process.env.NEXT_PUBLIC_HEIST_CONTRACT_ID || "";
const ZK_VERIFIER_CONTRACT =
  process.env.NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID || "";

/**
 * Build a complete TurnPublic, mock proof, and submit_turn transaction.
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
  authEntries: string[];
}> {
  const client = new HeistContractClient(HEIST_CONTRACT, RPC_URL);
  const isPlayer1 = playerAddress === view.player1;
  const startPos = isPlayer1 ? view.player1Pos : view.player2Pos;
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

  const { txXdr, authEntries } = await client.buildSubmitTurnTx(
    playerAddress,
    sessionId,
    playerAddress,
    proofBlob,
    finalTurn,
  );

  return { turn: finalTurn, proofBlob, txXdr, authEntries };
}
