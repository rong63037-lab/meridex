"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type PaperState = { enabled: boolean };

export function usePaperMode() {
  const [paper, setPaper] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(() => {
    if (typeof window === "undefined" || !localStorage.getItem("meridex.token")) {
      setReady(true);
      return;
    }
    api<PaperState>("/api/paper")
      .then((res) => setPaper(res.enabled))
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    refresh();
    const on = () => refresh();
    window.addEventListener("meridex-paper", on);
    return () => window.removeEventListener("meridex-paper", on);
  }, [refresh]);

  async function setEnabled(next: boolean) {
    const res = await api<PaperState>("/api/paper", {
      method: "POST",
      body: JSON.stringify({ action: next ? "enable" : "disable" }),
    });
    setPaper(res.enabled);
    window.dispatchEvent(new Event("meridex-paper"));
    return res.enabled;
  }

  return { paper, ready, refresh, setEnabled };
}
