/** All possible phases of a game lobby. */
export type LobbyPhase =
  | 'waiting'    // Waiting for player 2 to join
  | 'starting'   // start_game tx in progress
  | 'revealing'  // reveal_seed txs in progress
  | 'relaying'   // Backend is relaying map secrets between players
  | 'beginning'  // begin_match tx in progress
  | 'active'     // Game is live on-chain
  | 'ended'      // Game has finished
  | 'error';     // An unrecoverable error occurred

/**
 * A pending auth-entry signing request sent to a specific player.
 * Stored in Firestore so the frontend can poll for it and sign via wallet.
 */
export interface PendingAuthRequest {
  /** Identifier for the operation being signed (e.g. "start_game"). */
  purpose: string;
  /** Stellar public key of the player whose wallet must sign. */
  playerAddress: string;
  /** Base64-encoded XDR of the Soroban authorization preimage to sign. */
  preimageXdr: string;
  /** ISO timestamp of when the request was created. */
  requestedAt: string;
}

/**
 * A player's wallet signature in response to a pending auth-entry request.
 */
export interface SignatureResponse {
  /** Must match the `purpose` of the `pendingAuthRequest` being answered. */
  purpose: string;
  /** Stellar public key of the signing player. */
  playerAddress: string;
  /** Base64-encoded wallet signature. */
  signatureBase64: string;
  /** ISO timestamp of when the signature was submitted. */
  respondedAt: string;
}

/**
 * A player's map secret submission for the backend relay.
 * The backend verifies keccak(mapSecret) == on-chain pN_map_seed_commit,
 * then cross-relays to the other player.
 */
export interface MapSecretSubmission {
  playerAddress: string;
  /** Hex-encoded 32-byte map secret. */
  mapSecret: string;
  submittedAt: string;
}

/** Full lobby document as stored in Firestore. */
export interface LobbyDocument {
  gameId: string;
  sessionId: number;
  player1: string;
  player1SeedCommit: string;
  player1SeedSecret: string | null;
  /** keccak(player1MapSeedSecret) — committed on-chain at start_game. */
  player1MapSeedCommit: string | null;
  /** Hex-encoded 32-byte secret — relayed to player2, then cleared. */
  player1MapSeedSecret: string | null;
  player2: string | null;
  player2SeedCommit: string | null;
  player2SeedSecret: string | null;
  /** keccak(player2MapSeedSecret) — committed on-chain at start_game. */
  player2MapSeedCommit: string | null;
  /** Hex-encoded 32-byte secret — relayed to player1, then cleared. */
  player2MapSeedSecret: string | null;
  /**
   * Computed after begin_match succeeds: keccak256(p1SeedSecret || p2SeedSecret).
   * Stored so both players get the same value even if they call begin-match at
   * different times (idempotent relay).
   */
  sessionSeed?: string | null;
  phase: LobbyPhase;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Present while waiting for a player's wallet signature. */
  pendingAuthRequest?: PendingAuthRequest | null;
  /** Written by the frontend's auth-response POST; consumed and cleared by the backend. */
  signatureResponse?: SignatureResponse | null;
}

/** Input for creating a new lobby. */
export interface CreateLobbyInput {
  gameId: string;
  sessionId: number;
  player1: string;
  player1SeedCommit: string;
  player1SeedSecret?: string;
  player1MapSeedCommit?: string;
  player1MapSeedSecret?: string;
}

/** Input for player 2 joining a lobby. */
export interface JoinLobbyInput {
  player2: string;
  player2SeedCommit: string;
  player2SeedSecret?: string;
  player2MapSeedCommit?: string;
  player2MapSeedSecret?: string;
}

/** Partial update applied to an existing lobby. */
export type UpdateLobbyInput = Partial<
  Omit<LobbyDocument, 'gameId' | 'createdAt'>
>;
