import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { WalletProvider } from "../lib/wallet-context";

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  title: "Heist Duel — ZK Heist Game on Stellar",
  description:
    "A turn-based stealth game on Stellar. Navigate a 12×12 grid, collect loot, dodge cameras and lasers, then escape through the exit. Every move verified on-chain with zero-knowledge proofs.",
  metadataBase: new URL(BASE_URL),

  openGraph: {
    type: "website",
    url: BASE_URL,
    title: "Heist Duel — ZK Heist Game on Stellar",
    description:
      "A turn-based stealth game on Stellar. Navigate a 12×12 grid, collect loot, dodge cameras and lasers, then escape. ZK proofs on every move.",
    siteName: "Heist Duel",
    images: [
      {
        url: "/thumbnail.png",
        width: 1200,
        height: 630,
        alt: "Heist Duel — ZK Heist Game",
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    title: "Heist Duel — ZK Heist Game on Stellar",
    description:
      "Turn-based stealth game on Stellar with zero-knowledge proofs. Navigate the grid, collect loot, escape. Play now!",
    images: ["/thumbnail.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-heist-dark text-gray-200 antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
