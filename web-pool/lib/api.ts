export function authHeaders(): HeadersInit {
  const token = typeof window === "undefined" ? null : localStorage.getItem("meridex.pool.token");
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers ?? {}) } });
  const text = await res.text();
  const data = text ? JSON.parse(text) as T & { error?: string } : ({} as T & { error?: string });
  if (!res.ok) throw new Error(data.error || `HTTP_${res.status}`);
  return data;
}
