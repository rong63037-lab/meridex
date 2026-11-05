"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

const KEY = "meridex.watch";
const EVENT = "meridex-watch";

export const DEFAULT_WATCH = ["XAU/USD", "XAG/USD", "BTC/USD", "ETH/USD"];

function readLocal(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function useWatchlist() {
  const [watch, setWatch] = useState<string[]>([]);

  const publish = useCallback((next: string[]) => {
    localStorage.setItem(KEY, JSON.stringify(next));
    setWatch(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  useEffect(() => {
    const sync = () => setWatch(readLocal());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    let cancelled = false;
    api<{ symbols: string[] }>("/api/watchlist")
      .then((res) => {
        if (cancelled || readLocal().length) return;
        if (res.symbols?.length) publish(res.symbols);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [publish]);

  const replace = useCallback((symbols: string[]) => {
    const next = [...new Set(symbols)];
    publish(next);
    for (const symbol of next) {
      api("/api/watchlist", { method: "POST", body: JSON.stringify({ symbol }) }).catch(() => undefined);
    }
  }, [publish]);

  const toggle = useCallback((symbol: string) => {
    const current = readLocal();
    const next = current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol];
    publish(next);
    const call = next.includes(symbol)
      ? api("/api/watchlist", { method: "POST", body: JSON.stringify({ symbol }) })
      : api(`/api/watchlist?symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" });
    call.catch(() => undefined);
  }, [publish]);

  return { watch, toggle, replace };
}
