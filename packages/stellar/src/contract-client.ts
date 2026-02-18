import {
  Contract,
  rpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  Keypair,
} from "@stellar/stellar-sdk";
import type { Position, TurnPublic, PlayerGameView, Camera, Laser } from "./types";
import { NETWORK_PASSPHRASE, BITSET_BYTES } from "./constants";

/**
 * Information about a Soroban auth entry that needs a player's signature.
 */
export interface AuthEntryInfo {
  /** Index of the auth entry within the operation's auth array */
  index: number;
  /** Stellar G... address of the required signer */
  address: string;
  /** Base64 XDR of the SorobanAuthorizationEntry (with extended expiration) */
  authEntryXdr: string;
  /** Ledger sequence until which the signature is valid */
  expirationLedger: number;
}

/* ------------------------------------------------------------------ */
/*  ScVal encoding helpers                                             */
/* ------------------------------------------------------------------ */

function u32Val(v: number): xdr.ScVal {
  return nativeToScVal(v, { type: "u32" });
}

function i128Val(v: bigint): xdr.ScVal {
  return nativeToScVal(v, { type: "i128" });
}

function addressVal(addr: string): xdr.ScVal {
  return new Address(addr).toScVal();
}

function bytesNVal(bytes: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function boolVal(v: boolean): xdr.ScVal {
  return nativeToScVal(v, { type: "bool" });
}

function positionVal(p: Position): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("x"),
      val: u32Val(p.x),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("y"),
      val: u32Val(p.y),
    }),
  ]);
}

function positionVecVal(positions: Position[]): xdr.ScVal {
  return xdr.ScVal.scvVec(positions.map(positionVal));
}

function turnPublicVal(turn: TurnPublic): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("camera_hits"),
      val: u32Val(turn.cameraHits),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("end_pos"),
      val: positionVal(turn.endPos),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("laser_hits"),
      val: u32Val(turn.laserHits),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("loot_collected_mask_delta"),
      val: bytesNVal(turn.lootCollectedMaskDelta),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("no_path_flag"),
      val: boolVal(turn.noPathFlag),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("path"),
      val: positionVecVal(turn.path),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("player"),
      val: addressVal(turn.player),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("rolled_value"),
      val: u32Val(turn.rolledValue),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("score_delta"),
      val: i128Val(turn.scoreDelta),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("session_id"),
      val: u32Val(turn.sessionId),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("start_pos"),
      val: positionVal(turn.startPos),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("state_hash_after"),
      val: bytesNVal(turn.stateHashAfter),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("state_hash_before"),
      val: bytesNVal(turn.stateHashBefore),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("turn_index"),
      val: u32Val(turn.turnIndex),
    }),
  ]);
}

/* ------------------------------------------------------------------ */
/*  ScVal decoding helpers                                             */
/* ------------------------------------------------------------------ */

function parsePosition(val: xdr.ScVal): Position {
  const map = val.map();
  if (!map) throw new Error("Expected map for Position");
  let x = 0,
    y = 0;
  for (const entry of map) {
    const key = entry.key().sym().toString();
    const v = scValToNative(entry.val());
    if (key === "x") x = Number(v);
    if (key === "y") y = Number(v);
  }
  return { x, y };
}

function parseCamera(val: xdr.ScVal): Camera {
  const map = val.map();
  if (!map) throw new Error("Expected map for Camera");
  let x = 0,
    y = 0,
    radius = 0;
  for (const entry of map) {
    const key = entry.key().sym().toString();
    const v = scValToNative(entry.val());
    if (key === "x") x = Number(v);
    if (key === "y") y = Number(v);
    if (key === "radius") radius = Number(v);
  }
  return { x, y, radius };
}

function parseLaser(val: xdr.ScVal): Laser {
  const map = val.map();
  if (!map) throw new Error("Expected map for Laser");
  let x1 = 0,
    y1 = 0,
    x2 = 0,
    y2 = 0;
  for (const entry of map) {
    const key = entry.key().sym().toString();
    const v = scValToNative(entry.val());
    if (key === "x1") x1 = Number(v);
    if (key === "y1") y1 = Number(v);
    if (key === "x2") x2 = Number(v);
    if (key === "y2") y2 = Number(v);
  }
  return { x1, y1, x2, y2 };
}

function parseBytesN(val: xdr.ScVal): Uint8Array {
  return new Uint8Array(val.bytes());
}

function parseOptionalAddress(val: xdr.ScVal): string | null {
  const v = scValToNative(val);
  if (v === null || v === undefined) return null;
  return String(v);
}

function parseGameStatus(val: xdr.ScVal): string {
  const vec = val.vec();
  if (vec && vec.length > 0) {
    return vec[0]!.sym().toString();
  }
  return scValToNative(val);
}

function parsePlayerGameView(resultVal: xdr.ScVal): PlayerGameView {
  const map = resultVal.map();
  if (!map) throw new Error("Expected map for PlayerGameView");

  const view: Record<string, unknown> = {};
  for (const entry of map) {
    const key = entry.key().sym().toString();
    view[key] = entry.val();
  }

  return {
    player1: scValToNative(view["player1"] as xdr.ScVal),
    player2: scValToNative(view["player2"] as xdr.ScVal),
    status: parseGameStatus(view["status"] as xdr.ScVal),
    startedAtTs: scValToNative(view["started_at_ts"] as xdr.ScVal) ?? null,
    deadlineTs: scValToNative(view["deadline_ts"] as xdr.ScVal) ?? null,
    turnIndex: Number(scValToNative(view["turn_index"] as xdr.ScVal)),
    activePlayer: scValToNative(view["active_player"] as xdr.ScVal),
    player1Pos: parsePosition(view["player1_pos"] as xdr.ScVal),
    player2Pos: parsePosition(view["player2_pos"] as xdr.ScVal),
    player1Score: BigInt(scValToNative(view["player1_score"] as xdr.ScVal)),
    player2Score: BigInt(scValToNative(view["player2_score"] as xdr.ScVal)),
    lootCollected: parseBytesN(view["loot_collected"] as xdr.ScVal),
    visibleWalls: parseBytesN(view["visible_walls"] as xdr.ScVal),
    visibleLoot: parseBytesN(view["visible_loot"] as xdr.ScVal),
    visibleCameras: ((view["visible_cameras"] as xdr.ScVal).vec() ?? []).map(
      parseCamera,
    ),
    visibleLasers: ((view["visible_lasers"] as xdr.ScVal).vec() ?? []).map(
      parseLaser,
    ),
    myFog: parseBytesN(view["my_fog"] as xdr.ScVal),
    winner: parseOptionalAddress(view["winner"] as xdr.ScVal),
    lastProofId: (() => {
      const v = scValToNative(view["last_proof_id"] as xdr.ScVal);
      return v ? new Uint8Array(v) : null;
    })(),
  } as PlayerGameView;
}

/* ------------------------------------------------------------------ */
/*  Contract Client                                                    */
/* ------------------------------------------------------------------ */

export class HeistContractClient {
  private contractId: string;
  private contract: Contract;
  private server: rpc.Server;
  private rpcUrl: string;

  constructor(
    contractId: string,
    rpcUrl: string,
  ) {
    this.contractId = contractId;
    this.contract = contractId ? new Contract(contractId) : (null as unknown as Contract);
    this.server = new rpc.Server(rpcUrl);
    this.rpcUrl = rpcUrl;
  }

  private ensureContract(): Contract {
    if (!this.contract) {
      throw new Error("HeistContractClient: contractId not set");
    }
    return this.contract;
  }

  /**
   * Parse the assembled transaction envelope, extend auth entry expiration,
   * and return the modified transaction XDR along with auth entry info.
   * The auth entries are sent to the frontend for signing via `authorizeEntry`.
   */
  private processAuthEntries(
    assembled: ReturnType<TransactionBuilder["build"]>,
    latestLedger: number,
  ): { txXdr: string; authInfos: AuthEntryInfo[] } {
    const envelope = xdr.TransactionEnvelope.fromXDR(assembled.toXDR(), "base64");
    const expiration = latestLedger + 1000;
    const authInfos: AuthEntryInfo[] = [];

    const ops = envelope.v1().tx().operations();
    for (const op of ops) {
      const hostFn = op.body().invokeHostFunctionOp();
      if (hostFn) {
        const authArr = hostFn.auth();
        for (let i = 0; i < authArr.length; i++) {
          const auth = authArr[i]!;
          const creds = auth.credentials();
          if (creds.switch().name === "sorobanCredentialsAddress") {
            const addrCreds = creds.address();
            addrCreds.signatureExpirationLedger(expiration);

            authInfos.push({
              index: i,
              address: Address.fromScAddress(addrCreds.address()).toString(),
              authEntryXdr: auth.toXDR("base64"),
              expirationLedger: expiration,
            });
          }
        }
      }
    }

    return { txXdr: envelope.toXDR("base64"), authInfos };
  }

  /**
   * Replace an auth entry in a transaction XDR with a signed version.
   * The signed entry comes from `authorizeEntry` on the frontend.
   */
  static replaceAuthEntry(
    txXdr: string,
    authIndex: number,
    signedAuthEntryXdr: string,
  ): string {
    const envelope = xdr.TransactionEnvelope.fromXDR(txXdr, "base64");
    const ops = envelope.v1().tx().operations();
    for (const op of ops) {
      const hostFn = op.body().invokeHostFunctionOp();
      if (hostFn) {
        const authArr = hostFn.auth();
        authArr[authIndex] = xdr.SorobanAuthorizationEntry.fromXDR(
          signedAuthEntryXdr,
          "base64",
        );
        break;
      }
    }
    return envelope.toXDR("base64");
  }

  /* -- Read-only calls via simulation -- */

  private async simulateCall(
    sourceAddress: string,
    method: string,
    ...args: xdr.ScVal[]
  ): Promise<xdr.ScVal> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(this.ensureContract().call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error: ${sim.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation failed");
    }
    const result = sim.result;
    if (!result) throw new Error("No simulation result");
    return result.retval;
  }

  async getPlayerView(
    sourceAddress: string,
    sessionId: number,
    player: string,
  ): Promise<PlayerGameView> {
    // get_player_view returns Result<PlayerGameView, Error>.
    // On success the Soroban host unwraps the Ok variant: retval IS the
    // PlayerGameView ScvMap directly (not wrapped in a ScvVec).
    const retval = await this.simulateCall(
      sourceAddress,
      "get_player_view",
      u32Val(sessionId),
      addressVal(player),
    );
    return parsePlayerGameView(retval);
  }

  async getExpectedRoll(
    sourceAddress: string,
    sessionId: number,
    player: string,
  ): Promise<number> {
    // Returns Result<u32, Error> — retval IS the u32 ScVal directly.
    const retval = await this.simulateCall(
      sourceAddress,
      "get_expected_roll",
      u32Val(sessionId),
      addressVal(player),
    );
    return Number(scValToNative(retval));
  }

  async getStateHash(
    sourceAddress: string,
    sessionId: number,
  ): Promise<Uint8Array> {
    // Returns Result<BytesN<32>, Error> — retval IS the bytes ScVal directly.
    const retval = await this.simulateCall(
      sourceAddress,
      "get_state_hash",
      u32Val(sessionId),
    );
    return parseBytesN(retval);
  }

  async simulateStateHashAfter(
    sourceAddress: string,
    sessionId: number,
    turn: TurnPublic,
  ): Promise<Uint8Array> {
    // Returns Result<BytesN<32>, Error> — retval IS the bytes ScVal directly.
    const retval = await this.simulateCall(
      sourceAddress,
      "simulate_state_hash_after",
      u32Val(sessionId),
      turnPublicVal(turn),
    );
    return parseBytesN(retval);
  }

  async hashTurnPublic(
    sourceAddress: string,
    turn: TurnPublic,
  ): Promise<Uint8Array> {
    const retval = await this.simulateCall(
      sourceAddress,
      "hash_turn_public",
      turnPublicVal(turn),
    );
    return parseBytesN(retval);
  }

  /**
   * Returns the loot-collected mask delta that the contract would compute for
   * a given path, based on the *current* on-chain loot state.
   * Use this in `buildTurn` to avoid submitting stale/incorrect loot deltas
   * caused by the client view being out of date.
   */
  async getPathLootDelta(
    sourceAddress: string,
    sessionId: number,
    path: Position[],
  ): Promise<Uint8Array> {
    // Returns Result<BytesN<18>, Error>  →  on success: bytes ScVal directly
    const retval = await this.simulateCall(
      sourceAddress,
      "get_path_loot_delta",
      u32Val(sessionId),
      positionVecVal(path),
    );
    return parseBytesN(retval);
  }

  /**
   * Returns the (camera_hits, laser_hits) the contract would compute for a
   * given path.  This accounts for ALL cameras/lasers on the map, including
   * those the player cannot see due to fog-of-war.  Use this when building a
   * turn to ensure the submitted hazard counts match what the contract expects.
   */
  async getPathHazards(
    sourceAddress: string,
    sessionId: number,
    path: Position[],
  ): Promise<{ cameraHits: number; laserHits: number }> {
    // Returns Result<(u32, u32), Error>  →  on success: ScvVec([u32, u32])
    const retval = await this.simulateCall(
      sourceAddress,
      "get_path_hazards",
      u32Val(sessionId),
      positionVecVal(path),
    );
    const vec = retval.vec();
    if (!vec || vec.length !== 2) {
      throw new Error("Unexpected get_path_hazards result");
    }
    return {
      cameraHits: Number(scValToNative(vec[0]!)),
      laserHits: Number(scValToNative(vec[1]!)),
    };
  }

  async getVkHash(
    verifierContractId: string,
    sourceAddress: string,
  ): Promise<Uint8Array | null> {
    const verifier = new Contract(verifierContractId);
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(verifier.call("get_vk_hash"))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return null;
    if (!rpc.Api.isSimulationSuccess(sim)) return null;
    const result = sim.result;
    if (!result) return null;
    try {
      // The verifier's get_vk_hash returns BytesN<32> directly (no Result wrapper).
      return parseBytesN(result.retval);
    } catch {
      return null;
    }
  }

  /* -- Transaction building (for signing externally) -- */

  async buildStartGameTx(
    sourceAddress: string,
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    p1SeedCommit: Uint8Array,
    p2SeedCommit: Uint8Array,
  ): Promise<{ txXdr: string; authInfos: AuthEntryInfo[] }> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        this.ensureContract().call(
          "start_game",
          u32Val(sessionId),
          addressVal(player1),
          addressVal(player2),
          i128Val(player1Points),
          i128Val(player2Points),
          bytesNVal(p1SeedCommit),
          bytesNVal(p2SeedCommit),
        ),
      )
      .setTimeout(300)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error: ${sim.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(sim)) {
      throw new Error("Simulation failed");
    }

    const assembled = rpc.assembleTransaction(tx, sim).build();
    return this.processAuthEntries(assembled, sim.latestLedger);
  }

  async buildRevealSeedTx(
    sourceAddress: string,
    sessionId: number,
    player: string,
    seedSecret: Uint8Array,
  ): Promise<{ txXdr: string; authInfos: AuthEntryInfo[] }> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        this.ensureContract().call(
          "reveal_seed",
          u32Val(sessionId),
          addressVal(player),
          bytesNVal(seedSecret),
        ),
      )
      .setTimeout(300)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error: ${sim.error}`);
    }

    const assembled = rpc.assembleTransaction(tx, sim).build();
    return this.processAuthEntries(assembled, sim.latestLedger);
  }

  async buildBeginMatchTx(
    sourceAddress: string,
    sessionId: number,
  ): Promise<{ txXdr: string; authInfos: AuthEntryInfo[] }> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(this.ensureContract().call("begin_match", u32Val(sessionId)))
      .setTimeout(300)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error: ${sim.error}`);
    }

    const assembled = rpc.assembleTransaction(tx, sim).build();
    return this.processAuthEntries(assembled, sim.latestLedger);
  }

  async buildSubmitTurnTx(
    sourceAddress: string,
    sessionId: number,
    player: string,
    proofBlob: Uint8Array,
    turn: TurnPublic,
  ): Promise<{ txXdr: string; authInfos: AuthEntryInfo[] }> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        this.ensureContract().call(
          "submit_turn",
          u32Val(sessionId),
          addressVal(player),
          bytesNVal(proofBlob),
          turnPublicVal(turn),
        ),
      )
      .setTimeout(300)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`Simulation error: ${sim.error}`);
    }

    const assembled = rpc.assembleTransaction(tx, sim).build();
    return this.processAuthEntries(assembled, sim.latestLedger);
  }

  /**
   * Build a transaction that calls `end_if_finished` — callable by anyone,
   * no auth entries required.  Use this when a `submit_turn` simulation fails
   * with `TimerExpired` to finalize the game on-chain.
   */
  async buildEndIfFinishedTx(
    sourceAddress: string,
    sessionId: number,
  ): Promise<string> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "500000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        this.ensureContract().call("end_if_finished", u32Val(sessionId)),
      )
      .setTimeout(300)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`end_if_finished simulation error: ${sim.error}`);
    }
    const assembled = rpc.assembleTransaction(tx, sim).build();
    return assembled.toXDR();
  }

  /**
   * Submit a fully signed transaction to the network and wait for confirmation.
   */
  async submitTx(signedTxXdr: string): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
    const sendResult = await this.server.sendTransaction(tx);

    if (sendResult.status === "ERROR") {
      throw new Error(`Send failed: ${sendResult.errorResult?.toXDR("base64")}`);
    }

    let getResult = await this.server.getTransaction(sendResult.hash);
    while (getResult.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(sendResult.hash);
    }

    if (getResult.status === "SUCCESS") {
      return getResult as rpc.Api.GetSuccessfulTransactionResponse;
    }
    throw new Error(`Transaction failed: ${getResult.status}`);
  }

  /**
   * Replace unsigned auth entries in a transaction XDR with signed ones.
   */
  static replaceAuthEntries(
    txXdr: string,
    signedAuthEntries: string[],
  ): string {
    const envelope = xdr.TransactionEnvelope.fromXDR(txXdr, "base64");
    const txBody = envelope.v1().tx();
    const ops = txBody.operations();

    for (const op of ops) {
      const hostFn = op.body().invokeHostFunctionOp();
      if (hostFn) {
        const newAuth = signedAuthEntries.map((e) =>
          xdr.SorobanAuthorizationEntry.fromXDR(e, "base64"),
        );
        hostFn.auth(newAuth);
      }
    }

    return envelope.toXDR("base64");
  }

  /**
   * Sign the outer transaction envelope with a keypair (for the source account).
   */
  static signWithKeypair(txXdr: string, keypair: Keypair): string {
    const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
    tx.sign(keypair);
    return tx.toXDR();
  }
}
