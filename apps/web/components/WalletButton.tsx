"use client";

import { useWallet } from "../lib/wallet-context";

export function WalletButton() {
  const { address, connected, connecting, connect, disconnect } = useWallet();

  if (connected && address) {
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-lg bg-heist-card px-3 py-2 text-sm font-mono text-heist-green border border-heist-border">
          {address.slice(0, 4)}...{address.slice(-4)}
        </span>
        <button
          onClick={disconnect}
          className="rounded-lg bg-heist-card px-3 py-2 text-sm text-gray-400 border border-heist-border hover:border-heist-red hover:text-heist-red transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={connecting}
      className="rounded-lg bg-heist-green/10 border border-heist-green/30 px-6 py-3 text-heist-green font-semibold hover:bg-heist-green/20 hover:border-heist-green/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed glow-green"
    >
      {connecting ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
