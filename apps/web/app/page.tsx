import { uiName } from "@repo/ui";

export default function HomePage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: 24 }}>
      <h1>Heist Duel</h1>
      <p>Monorepo Turbo pret avec apps web/api et packages.</p>
      <p>Package partage actif: {uiName}</p>
    </main>
  );
}
