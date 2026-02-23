"use client";

import { useWallet } from "../lib/wallet-context";

// ─── Account-not-found popup ──────────────────────────────────────────────────

function UnfundedAccountModal() {
  const { unfundedAddress, fundingAccount, fundWithFriendbot, dismissUnfunded, connect } =
    useWallet();

  if (!unfundedAddress) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="rounded-2xl bg-heist-card border border-heist-border p-8 max-w-sm w-full text-center space-y-5 shadow-2xl">

        {/* Icon */}
        <div className="w-14 h-14 rounded-full bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center mx-auto">
          <svg className="w-7 h-7 text-yellow-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>

        {/* Title + description */}
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-white">Address not found</h2>
          <p className="text-gray-400 text-sm leading-relaxed">
            The address{" "}
            <span className="font-mono text-heist-green">
              {unfundedAddress.slice(0, 6)}…{unfundedAddress.slice(-4)}
            </span>{" "}
            does not exist yet on Stellar Testnet.
          </p>
          <p className="text-gray-500 text-xs leading-relaxed">
            You can activate it for free by clicking the button below.
            Friendbot will credit it with some test XLM.
          </p>
        </div>

        {/* Fund button */}
        <button
          onClick={() => void fundWithFriendbot()}
          disabled={fundingAccount}
          className="w-full rounded-xl bg-heist-green/10 border-2 border-heist-green/30 px-6 py-3 font-semibold text-heist-green hover:bg-heist-green/20 hover:border-heist-green/50 disabled:opacity-50 disabled:cursor-not-allowed transition-all glow-green flex items-center justify-center gap-2"
        >
          {fundingAccount ? (
            <>
              <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Activating…
            </>
          ) : (
            <>
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Fund via Friendbot
            </>
          )}
        </button>

        {/* Reconnect after funding (visible once funded) */}
        {!fundingAccount && (
          <button
            onClick={() => void connect()}
            className="w-full rounded-xl bg-heist-blue/10 border border-heist-blue/30 px-6 py-2.5 text-sm font-semibold text-heist-blue hover:bg-heist-blue/20 transition-all"
          >
            Reconnect wallet
          </button>
        )}

        {/* Cancel */}
        <button
          onClick={dismissUnfunded}
          disabled={fundingAccount}
          className="w-full text-xs text-gray-600 hover:text-gray-400 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Main button ──────────────────────────────────────────────────────────────

export function WalletButton() {
  const { address, connected, connecting, connect, disconnect } = useWallet();

  return (
    <>
      {/* Always-present popup overlay (renders nothing when not needed) */}
      <UnfundedAccountModal />

      {connected && address ? (
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
      ) : (
        <button
          onClick={() => void connect()}
          disabled={connecting}
          className="rounded-lg bg-heist-green/10 border border-heist-green/30 px-6 py-3 text-heist-green font-semibold hover:bg-heist-green/20 hover:border-heist-green/60 transition-all disabled:opacity-50 disabled:cursor-not-allowed glow-green"
        >
          {connecting ? "Connecting..." : "Connect Wallet"}
        </button>
      )}
    </>
  );
}
