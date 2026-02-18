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

interface WalletContextValue {
  kit: StellarWalletsKit | null;
  address: string | null;
  connected: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (txXdr: string) => Promise<string>;
  signAuthEntry: (entryXdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue>({
  kit: null,
  address: null,
  connected: false,
  connecting: false,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
  signAuthEntry: async () => "",
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [kit, setKit] = useState<StellarWalletsKit | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

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
        connect,
        disconnect,
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
