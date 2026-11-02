// Simple line icons for the pro navigation (drawn here, no third-party assets).
type Name = "home" | "markets" | "trade" | "earn" | "wallet" | "search" | "grid" | "globe" | "chat" | "down" | "up" | "history" | "more" | "chart";
const paths: Record<Name, string> = {
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  markets: "M4 19V9M10 19V5M16 19v-7M22 19H2",
  trade: "M7 4v13l-3-3M17 20V7l3 3",
  earn: "M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.6 5 3.2 5 1.4 5 3.3-2.2 3-5 3-5-1.1-5-3",
  wallet: "M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l13-3v3M16 13h2",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  grid: "M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z",
  chat: "M4 5h16v11H9l-5 4z",
  down: "M12 4v14M6 12l6 6 6-6",
  up: "M12 20V6M6 12l6-6 6 6",
  history: "M4 12a8 8 0 1 0 2.3-5.6L4 8.7M4 4v4.7h4.7M12 8v4l3 2",
  more: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  chart: "M3 17l5-5 4 4 8-8M15 8h5v5",
};
export function ProIcon({ name, size = 20 }: { name: Name; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[name]} />
    </svg>
  );
}
