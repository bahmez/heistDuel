import type { ReactNode } from "react";
import "./globals.css";
import { WalletProvider } from "../lib/wallet-context";
import { SocketProvider } from "../lib/socket-context";

export const metadata = {
  title: "Heist Duel",
  description: "ZK turn-based heist game on Stellar",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-heist-dark text-gray-200 antialiased">
        <WalletProvider>
          <SocketProvider>{children}</SocketProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
