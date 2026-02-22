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
import type { TurnZkPublic, GameView } from "./types";
export type { GameView } from "./types";
import { NETWORK_PASSPHRASE } from "./constants";

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

/**
 * Encode a TurnZkPublic as a Soroban ScvMap.
 * Fields must be in alphabetical order (Soroban contracttype requirement).
 */
function turnZkPublicVal(turn: TurnZkPublic): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("loot_delta"),
      val: u32Val(turn.lootDelta),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("no_path_flag"),
      val: boolVal(turn.noPathFlag),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("player"),
      val: addressVal(turn.player),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("pos_commit_after"),
      val: bytesNVal(turn.posCommitAfter),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("pos_commit_before"),
      val: bytesNVal(turn.posCommitBefore),
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
      key: xdr.ScVal.scvSymbol("state_commit_after"),
      val: bytesNVal(turn.stateCommitAfter),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("state_commit_before"),
      val: bytesNVal(turn.stateCommitBefore),
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

function parseGameView(resultVal: xdr.ScVal): GameView {
  const map = resultVal.map();
  if (!map) throw new Error("Expected map for GameView");

  const view: Record<string, unknown> = {};
  for (const entry of map) {
    const key = entry.key().sym().toString();
    view[key] = entry.val();
  }

  return {
    player1: scValToNative(view["player1"] as xdr.ScVal),
    player2: scValToNative(view["player2"] as xdr.ScVal),
    status: parseGameStatus(view["status"] as xdr.ScVal) as GameView["status"],
    startedAtTs: scValToNative(view["started_at_ts"] as xdr.ScVal) ?? null,
    deadlineTs: scValToNative(view["deadline_ts"] as xdr.ScVal) ?? null,
    turnIndex: Number(scValToNative(view["turn_index"] as xdr.ScVal)),
    activePlayer: scValToNative(view["active_player"] as xdr.ScVal),
    player1Score: BigInt(scValToNative(view["player1_score"] as xdr.ScVal)),
    player2Score: BigInt(scValToNative(view["player2_score"] as xdr.ScVal)),
    lootTotalCollected: Number(scValToNative(view["loot_total_collected"] as xdr.ScVal)),
    mapCommitment: parseBytesN(view["map_commitment"] as xdr.ScVal),
    player1PosCommit: parseBytesN(view["player1_pos_commit"] as xdr.ScVal),
    player2PosCommit: parseBytesN(view["player2_pos_commit"] as xdr.ScVal),
    p1MapSeedCommit: parseBytesN(view["p1_map_seed_commit"] as xdr.ScVal),
    p2MapSeedCommit: parseBytesN(view["p2_map_seed_commit"] as xdr.ScVal),
    stateCommitment: parseBytesN(view["state_commitment"] as xdr.ScVal),
    winner: parseOptionalAddress(view["winner"] as xdr.ScVal),
    lastProofId: (() => {
      const v = scValToNative(view["last_proof_id"] as xdr.ScVal);
      return v ? new Uint8Array(v) : null;
    })(),
  };
}

/* ------------------------------------------------------------------ */
/*  Contract Client                                                    */
/* ------------------------------------------------------------------ */

export class HeistContractClient {
  private contractId: string;
  private contract: Contract;
  private server: rpc.Server;
  private rpcUrl: string;

  constructor(contractId: string, rpcUrl: string) {
    this.contractId = contractId;
    this.contract = contractId
      ? new Contract(contractId)
      : (null as unknown as Contract);
    this.server = new rpc.Server(rpcUrl);
    this.rpcUrl = rpcUrl;
  }

  private ensureContract(): Contract {
    if (!this.contract) {
      throw new Error("HeistContractClient: contractId not set");
    }
    return this.contract;
  }

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

  /* -- Read-only simulation calls -- */

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

  /**
   * Get the full game view (requires admin/backend source address since get_game
   * uses require_auth with the admin account).
   * In Soroban simulation, if source == admin address, require_auth() passes automatically.
   */
  async getGameView(
    adminAddress: string,
    sessionId: number,
  ): Promise<GameView> {
    const retval = await this.simulateCall(
      adminAddress,
      "get_game",
      u32Val(sessionId),
    );
    return parseGameView(retval);
  }

  async getStateCommitment(
    sourceAddress: string,
    sessionId: number,
  ): Promise<Uint8Array> {
    const retval = await this.simulateCall(
      sourceAddress,
      "get_state_commitment",
      u32Val(sessionId),
    );
    return parseBytesN(retval);
  }

  async getExpectedRoll(
    sourceAddress: string,
    sessionId: number,
    player: string,
  ): Promise<number> {
    const retval = await this.simulateCall(
      sourceAddress,
      "get_expected_roll",
      u32Val(sessionId),
      addressVal(player),
    );
    return Number(scValToNative(retval));
  }

  /** Compute the pi_hash for a given TurnZkPublic (used to build proof_blob). */
  async computePiHash(
    sourceAddress: string,
    sessionId: number,
    turn: TurnZkPublic,
  ): Promise<Uint8Array> {
    const retval = await this.simulateCall(
      sourceAddress,
      "compute_pi_hash",
      u32Val(sessionId),
      turnZkPublicVal(turn),
    );
    return parseBytesN(retval);
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
      return parseBytesN(result.retval);
    } catch {
      return null;
    }
  }

  /* -- Transaction builders -- */

  /**
   * Build the start_game transaction.
   *
   * Both players must sign with their respective auth entries.
   * Each player commits to two secrets:
   *  - seedCommit: for dice randomness (revealed later via reveal_seed)
   *  - mapSeedCommit: for map generation (secret never revealed on-chain;
   *    relayed off-chain via backend after both seeds are revealed)
   */
  async buildStartGameTx(
    sourceAddress: string,
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    p1SeedCommit: Uint8Array,
    p2SeedCommit: Uint8Array,
    p1MapSeedCommit: Uint8Array,
    p2MapSeedCommit: Uint8Array,
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
          bytesNVal(p1MapSeedCommit),
          bytesNVal(p2MapSeedCommit),
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

  /**
   * Build the begin_match transaction.
   *
   * Requires both players to sign. The map_commitment is agreed off-chain:
   * each player computes map_seed = keccak(secret1 XOR secret2) then
   * map_commitment = keccak(generate_map(map_seed)) and both provide the
   * same value here. Initial position commitments are provided by each player.
   */
  async buildBeginMatchTx(
    sourceAddress: string,
    sessionId: number,
    mapCommitment: Uint8Array,
    p1PosCommit: Uint8Array,
    p2PosCommit: Uint8Array,
  ): Promise<{ txXdr: string; authInfos: AuthEntryInfo[] }> {
    const account = await this.server.getAccount(sourceAddress);
    const tx = new TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        this.ensureContract().call(
          "begin_match",
          u32Val(sessionId),
          bytesNVal(mapCommitment),
          bytesNVal(p1PosCommit),
          bytesNVal(p2PosCommit),
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

  async buildSubmitTurnTx(
    sourceAddress: string,
    sessionId: number,
    player: string,
    proofBlob: Uint8Array,
    turn: TurnZkPublic,
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
          turnZkPublicVal(turn),
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

  async submitTx(
    signedTxXdr: string,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
    const sendResult = await this.server.sendTransaction(tx);

    if (sendResult.status === "ERROR") {
      throw new Error(
        `Send failed: ${sendResult.errorResult?.toXDR("base64")}`,
      );
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

  static replaceAuthEntries(txXdr: string, signedAuthEntries: string[]): string {
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

  static signWithKeypair(txXdr: string, keypair: Keypair): string {
    const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
    tx.sign(keypair);
    return tx.toXDR();
  }
}
