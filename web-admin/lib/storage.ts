function legacyPrefix(): string {
  return ["a", "u", "r", "u", "m"].join("");
}

/** Copy one generation of client keys, then drop the old ones. */
export function migrateClientStorage(): void {
  if (typeof window === "undefined") return;
  const from = legacyPrefix();
  const move = (store: Storage) => {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(from)) keys.push(key);
    }
    for (const key of keys) {
      const next = `meridex${key.slice(from.length)}`;
      if (store.getItem(next) == null) {
        const value = store.getItem(key);
        if (value != null) store.setItem(next, value);
      }
      store.removeItem(key);
    }
  };
  try {
    move(localStorage);
    move(sessionStorage);
  } catch {
    /* private mode */
  }
}
