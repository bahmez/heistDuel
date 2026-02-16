import type { ReactNode } from "react";

export const metadata = {
  title: "Heist Duel Web",
  description: "Frontend app for the Heist Duel monorepo"
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
