import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1c1712",
        paper: "#f3eee4",
        gold: "#9a7340",
        desk: "#100e0c",
        bid: "#7ea88a",
        ask: "#d48474",
      },
      fontFamily: {
        sans: ["Outfit", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "sans-serif"],
        serif: ["Newsreader", "Noto Serif SC", "Songti SC", "serif"],
      },
      boxShadow: {
        slip: "0 24px 60px rgba(40, 28, 12, 0.12)",
      },
    },
  },
  plugins: [],
};

export default config;
