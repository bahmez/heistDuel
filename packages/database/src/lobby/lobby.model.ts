/** All possible phases of a game lobby. */
export type LobbyPhase =
  | 'waiting'    // Waiting for player 2 to join
  | 'starting'   // start_game tx in progress
  | 'revealing'  // reveal_seed txs in progress
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
 * Written to Firestore by the backend's `/auth-response` endpoint and picked
 * up by the backend's Firestore `onSnapshot` listener to continue the game flow.
 * Replacing the old in-memory Promise-resolver map so signatures survive API restarts.
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

/** Full lobby document as stored in Firestore. */
export interface LobbyDocument {
  gameId: string;
  sessionId: number;
  player1: string;
  player1SeedCommit: string;
  player1SeedSecret: string | null;
  player2: string | null;
  player2SeedCommit: string | null;
  player2SeedSecret: string | null;
  phase: LobbyPhase;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Present while waiting for a player's wallet signature. Drives SSE/frontend sign flow. */
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
}

/** Input for player 2 joining a lobby. */
export interface JoinLobbyInput {
  player2: string;
  player2SeedCommit: string;
  player2SeedSecret?: string;
}

/** Partial update applied to an existing lobby. */
export type UpdateLobbyInput = Partial<
  Omit<LobbyDocument, 'gameId' | 'createdAt'>
>;
