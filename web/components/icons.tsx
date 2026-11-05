type Name = "shield" | "vault" | "scale" | "chart" | "globe" | "trend" | "hline" | "fib";

const paths: Record<Name, string> = {
  shield: "M12 3.5 19 6.2v5.3c0 4.2-2.8 7.2-7 8.9-4.2-1.7-7-4.7-7-8.9V6.2L12 3.5Z",
  vault: "M4.5 7.5h15v11h-15v-11Zm4 5.5a3.5 3.5 0 1 0 7 0 3.5 3.5 0 0 0-7 0Zm3.5-1.4v2.8",
  scale: "M12 4.5v15M7 19.5h10M8 8.5 4.5 14h7L8 8.5Zm8 0L12.5 14h7L16 8.5Z",
  chart: "M4.5 16.5 9 11l3 3 6.5-7",
  globe: "M12 19.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM4.8 12h14.4M12 4.6c2 2.1 3 4.7 3 7.4s-1 5.3-3 7.4c-2-2.1-3-4.7-3-7.4s1-5.3 3-7.4Z",
  trend: "M4 17.5 10 11l3.2 3.2L20 7",
  hline: "M4 12h16",
  fib: "M5 7h14M5 10.2h14M5 13h14M5 17h14",
};

export function Icon({ name }: { name: Name }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
