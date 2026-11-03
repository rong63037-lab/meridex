const LOCAL_ORIGINS = [
  "http://localhost:4317",
  "http://127.0.0.1:4317",
  "http://localhost:4318",
  "http://127.0.0.1:4318",
  "http://localhost:4319",
  "http://127.0.0.1:4319",
];

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function createOriginPolicy(configured = process.env.CORS_ORIGINS ?? "") {
  const allowed = new Set(LOCAL_ORIGINS);
  for (const entry of configured.split(",").map((value) => value.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(entry);
    if (!origin) throw new Error("INVALID_CORS_ORIGIN");
    allowed.add(origin);
  }
  return (candidate?: string): boolean => {
    if (!candidate) return false;
    const origin = normalizeOrigin(candidate);
    return origin !== null && allowed.has(origin);
  };
}
