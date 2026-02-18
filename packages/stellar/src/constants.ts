import { Networks } from "@stellar/stellar-sdk";

export const STELLAR_NETWORK = "testnet";
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export const HEIST_CONTRACT_ID =
  "CDULZSTR6IAPYOOCWNGXWNGSYKJNGRWWSJW6BQK2WFZHWQKCMROTTOPB";
export const ZK_VERIFIER_CONTRACT_ID =
  "CCERXBKY3LUJ6XTW2AN3LZJ7TSLM4GCKCGA3KAP2G6ARGK5CASKEJREL";
export const GAME_HUB_CONTRACT_ID =
  "CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG";

export const MAP_W = 12;
export const MAP_H = 12;
export const CELL_COUNT = MAP_W * MAP_H;
export const BITSET_BYTES = 18;
export const GAME_SECONDS = 300;
export const CAMERA_PENALTY = 1n;
export const LASER_PENALTY = 2n;
