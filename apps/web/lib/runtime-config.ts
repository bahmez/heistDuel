export interface RuntimeConfig {
  network: string;
  rpcUrl: string;
  heistContractId: string;
  zkVerifierContractId: string;
  vkHash: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
const FALLBACK_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
  "https://soroban-testnet.stellar.org";

let cachedConfig: RuntimeConfig | null = null;
let pendingFetch: Promise<RuntimeConfig> | null = null;

function getEnvFallback(): RuntimeConfig {
  return {
    network: process.env.NEXT_PUBLIC_STELLAR_NETWORK || "testnet",
    rpcUrl: FALLBACK_RPC_URL,
    heistContractId: process.env.NEXT_PUBLIC_HEIST_CONTRACT_ID || "",
    zkVerifierContractId:
      process.env.NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID || "",
    vkHash: process.env.NEXT_PUBLIC_VK_HASH || "",
  };
}

/**
 * Returns runtime game config from backend route with env fallback.
 * Result is memoized for the lifetime of the page.
 */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (cachedConfig) return cachedConfig;
  if (pendingFetch) return pendingFetch;

  pendingFetch = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/config/public`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as Partial<RuntimeConfig>;
      cachedConfig = {
        network: data.network || getEnvFallback().network,
        rpcUrl: data.rpcUrl || getEnvFallback().rpcUrl,
        heistContractId: data.heistContractId || getEnvFallback().heistContractId,
        zkVerifierContractId:
          data.zkVerifierContractId || getEnvFallback().zkVerifierContractId,
        vkHash: data.vkHash || getEnvFallback().vkHash,
      };
      return cachedConfig;
    } catch {
      cachedConfig = getEnvFallback();
      return cachedConfig;
    } finally {
      pendingFetch = null;
    }
  })();

  return pendingFetch;
}

