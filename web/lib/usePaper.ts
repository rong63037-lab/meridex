"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type PaperState = { enabled: boolean };

/**
 * One shared flag for every caller. The header, the order page, and the
 * coming-soon gate must agree on the first paint after a mode switch.
 * A late response from an older read cannot overwrite a newer switch.
 */
let paper = false;
let ready = false;
let gen = 0;
let seenToken: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function usePaperMode() {
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("meridex.token");
    if (!token) {
      paper = false;
      ready = true;
      seenToken = null;
      emit();
      return;
    }
    if (seenToken !== token) {
      ready = false;
      emit();
    }
    const ticket = ++gen;
    api<PaperState>("/api/paper")
      .then((res) => {
        if (ticket !== gen) return;
        seenToken = token;
        paper = res.enabled;
        ready = true;
        emit();
      })
      .catch(() => {
        if (ticket !== gen) return;
        ready = true;
        emit();
      });
  }, []);

  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    refresh();
    const on = () => refresh();
    window.addEventListener("meridex-paper", on);
    return () => {
      listeners.delete(fn);
      window.removeEventListener("meridex-paper", on);
    };
  }, [refresh]);

  async function setEnabled(next: boolean) {
    const ticket = ++gen;
    const res = await api<PaperState>("/api/paper", {
      method: "POST",
      body: JSON.stringify({ action: next ? "enable" : "disable" }),
    });
    if (ticket === gen) {
      const token = localStorage.getItem("meridex.token");
      if (token) seenToken = token;
      paper = res.enabled;
      ready = true;
      emit();
    }
    window.dispatchEvent(new Event("meridex-paper"));
    return res.enabled;
  }

  return { paper, ready, refresh, setEnabled };
}
