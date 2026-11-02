/** JSON request. Errors are status codes only, never the URL or a header. */

export type HttpResult = { status: number; body: unknown; ms: number };

export async function requestJson(url: string, init: RequestInit, timeoutMs = 4000): Promise<HttpResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const parent = init.signal;
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body, ms: Date.now() - started };
  } catch {
    return { status: 0, body: null, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onAbort);
  }
}
