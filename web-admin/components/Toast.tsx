"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Toast = { id: number; text: string; tone: "ok" | "bad" };

const Ctx = createContext<{ push: (text: string, tone?: "ok" | "bad") => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-4), { id, text, tone }]);
    window.setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== id)), 4200);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`}>{item.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  return ctx?.push ?? (() => undefined);
}
