/** A single contract deployment record persisted in Firestore. */
export interface DeploymentRecord {
  /** Unique identifier — ISO UTC timestamp of deployment, e.g. "2026-02-18T04:30:00Z". */
  id: string;
  /** Stellar network used for this deployment: "testnet" | "mainnet". */
  network: string;
  /** ISO 8601 timestamp of when the deployment was executed. */
  deployedAt: string;
  /** Source account alias or Stellar public key used to sign transactions. */
  source: string;
  /** Admin address (Stellar public key) set as contract admin. */
  admin: string;
  /** Game Hub contract ID passed to the heist contract on init. */
  gameHub: string;
  /** Deployed Heist contract ID. */
  heistContractId: string;
  /** Deployed ZK Verifier contract ID. */
  zkVerifierContractId: string;
  /** VK (verification key) hash registered on the verifier contract. */
  vkHash: string;
  /** WASM hash uploaded during an upgrade — only set when mode is "upgrade". */
  wasmHash?: string;
  /** Whether this was a fresh full deploy or an in-place upgrade of the heist contract. */
  mode: 'full' | 'upgrade';
}
