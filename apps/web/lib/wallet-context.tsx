"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import {
  StellarWalletsKit,
  WalletNetwork,
  allowAllModules,
  FREIGHTER_ID,
} from "@creit.tech/stellar-wallets-kit";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
}

function normalizeAuthSignatureResult(result: unknown): string {
  if (typeof result === "string") return result;

  if (!result || typeof result !== "object") {
    throw new Error("signAuthEntry returned an unexpected value");
  }

  const r = result as Record<string, unknown>;
  const candidate =
    r.signedAuthEntry ?? r.signature ?? r.signedAuthEntryXdr ?? null;

  if (typeof candidate === "string") return candidate;
  if (candidate instanceof Uint8Array) return bytesToBase64(candidate);
  if (Array.isArray(candidate)) return bytesToBase64(new Uint8Array(candidate));

  throw new Error(
    `Unsupported signAuthEntry response shape (keys: ${Object.keys(r).join(", ")})`,
  );
}

/** Returns true if the account exists and is funded on-chain. */
async function checkAccountExists(addr: string): Promise<boolean> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${addr}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    // Network error: assume the account exists to avoid blocking the user.
    return true;
  }
}

interface WalletContextValue {
  kit: StellarWalletsKit | null;
  address: string | null;
  connected: boolean;
  connecting: boolean;
  /** Address detected but not yet funded on-chain. */
  unfundedAddress: string | null;
  /** True while Friendbot call is in progress. */
  fundingAccount: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Fund the unfunded address via Friendbot then reconnect. */
  fundWithFriendbot: () => Promise<void>;
  /** Dismiss the "account not found" popup without funding. */
  dismissUnfunded: () => void;
  signTransaction: (txXdr: string) => Promise<string>;
  signAuthEntry: (entryXdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue>({
  kit: null,
  address: null,
  connected: false,
  connecting: false,
  unfundedAddress: null,
  fundingAccount: false,
  connect: async () => {},
  disconnect: () => {},
  fundWithFriendbot: async () => {},
  dismissUnfunded: () => {},
  signTransaction: async () => "",
  signAuthEntry: async () => "",
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [unfundedAddress, setUnfundedAddress] = useState<string | null>(null);
  const [fundingAccount, setFundingAccount] = useState(false);

  useEffect(() => {
    const walletKit = new StellarWalletsKit({
      network: WalletNetwork.TESTNET,
      selectedWalletId: FREIGHTER_ID,
      modules: allowAllModules(),
    });
    setKit(walletKit);
  }, []);

  const connect = useCallback(async () => {
    if (!kit) return;
    setConnecting(true);
    try {
      await kit.openModal({
        onWalletSelected: async (option) => {
          kit.setWallet(option.id);
          const { address: addr } = await kit.getAddress();

          // Check whether this address exists on-chain before continuing.
          const exists = await checkAccountExists(addr);
          if (!exists) {
            // Surface the "account not found" popup — do NOT set address yet.
            setUnfundedAddress(addr);
            return;
          }

          setAddress(addr);
        },
      });
    } catch (err) {
      console.error("Wallet connection failed:", err);
    } finally {
      setConnecting(false);
    }
  }, [kit]);

  const disconnect = useCallback(() => {
    setAddress(null);
  }, []);

  /**
   * Call Stellar Friendbot to fund the pending unfunded address,
   * then automatically complete the connection.
   */
  const fundWithFriendbot = useCallback(async () => {
    if (!unfundedAddress) return;
    setFundingAccount(true);
    try {
      const res = await fetch(
        `${FRIENDBOT_URL}/?addr=${encodeURIComponent(unfundedAddress)}`,
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Friendbot error ${res.status}: ${text}`);
      }
      // Account is now funded — complete the connection.
      setAddress(unfundedAddress);
      setUnfundedAddress(null);
    } catch (err) {
      console.error("Friendbot funding failed:", err);
    } finally {
      setFundingAccount(false);
    }
  }, [unfundedAddress]);

  const dismissUnfunded = useCallback(() => {
    setUnfundedAddress(null);
  }, []);

  const signTransaction = useCallback(
    async (txXdr: string): Promise<string> => {
      if (!kit || !address) throw new Error("Wallet not connected");
      const { signedTxXdr } = await kit.signTransaction(txXdr, {
        networkPassphrase: WalletNetwork.TESTNET,
        address,
      });
      return signedTxXdr;
    },
    [kit, address],
  );

  const signAuthEntry = useCallback(
    async (entryXdr: string): Promise<string> => {
      if (!kit || !address) throw new Error("Wallet not connected");
      const result = await kit.signAuthEntry(entryXdr, {
        networkPassphrase: WalletNetwork.TESTNET,
        address,
      });
      return normalizeAuthSignatureResult(result);
    },
    [kit, address],
  );

  return (
    <WalletContext.Provider
      value={{
        kit,
        address,
        connected: !!address,
        connecting,
        unfundedAddress,
        fundingAccount,
        connect,
        disconnect,
        fundWithFriendbot,
        dismissUnfunded,
        signTransaction,
        signAuthEntry,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
