export type LiveAnnouncement = { id: string; title: string; body: string; banner: boolean };

type LiveState = {
  overrides: Record<string, string>;
  numbers: Record<string, number>;
  announcements: LiveAnnouncement[];
};

let state: LiveState = { overrides: {}, numbers: {}, announcements: [] };
const listeners = new Set<() => void>();
let started = false;

export function currentOverrides(): Record<string, string> {
  return state.overrides;
}

export function liveNumbers(): Record<string, number> {
  return state.numbers;
}

export function liveNumber(key: string): number {
  const value = state.numbers[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function liveAnnouncements(): LiveAnnouncement[] {
  return state.announcements;
}

export function subscribeLive(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyCopy<T extends Record<string, string>>(prefix: string, lang: string, base: T): T {
  const next = { ...base };
  for (const key of Object.keys(base)) {
    const value = state.overrides[`${prefix}${lang}.${key}`];
    if (typeof value === "string") next[key as keyof T] = value as T[keyof T];
  }
  return next;
}

function publish(next: LiveState) {
  state = next;
  for (const fn of listeners) fn();
}

export function startLiveContent(): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (started) return () => undefined;
  started = true;
  let timer = 0;
  const pull = () => {
    fetch("/api/content", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        publish({
          overrides: (data.overrides ?? {}) as Record<string, string>,
          numbers: (data.numbers ?? {}) as Record<string, number>,
          announcements: (data.announcements ?? []) as LiveAnnouncement[],
        });
      })
      .catch(() => undefined);
  };
  pull();
  timer = window.setInterval(pull, 3000);
  return () => window.clearInterval(timer);
}
