/**
 * Test venues only. Production hosts are refused even if the base URL is edited.
 * A local mock (127.0.0.1 or localhost) is allowed so tests need no network.
 */

export const BINANCE_DEMO_DEFAULT = "https://demo-fapi.binance.com";
export const SAXO_SIM_DEFAULT = "https://gateway.saxobank.com/sim/openapi";
export const COINBASE_SANDBOX_DEFAULT = "https://api-public.sandbox.exchange.coinbase.com";

const BINANCE_PROD = new Set([
  "fapi.binance.com",
  "dapi.binance.com",
  "api.binance.com",
  "testnet.binancefuture.com",
  "fstream.binance.com",
  "ws-fapi.binance.com",
]);

export type HostOk = { ok: true; base: string };
export type HostNo = { ok: false };

function parsed(baseUrl: string, fallback: string): URL | null {
  const raw = (baseUrl.trim() || fallback).replace(/\/$/, "");
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function local(url: URL): boolean {
  return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (url.protocol === "http:" || url.protocol === "https:");
}

export function binanceDemoBase(baseUrl: string): HostOk | HostNo {
  const url = parsed(baseUrl, BINANCE_DEMO_DEFAULT);
  if (!url) return { ok: false };
  if (BINANCE_PROD.has(url.hostname)) return { ok: false };
  const demo = url.protocol === "https:" && (url.hostname === "demo-fapi.binance.com" || (url.hostname.startsWith("demo-") && url.hostname.endsWith(".binance.com")));
  if (!demo && !local(url)) return { ok: false };
  return { ok: true, base: url.toString().replace(/\/$/, "") };
}

export function saxoSimBase(baseUrl: string): HostOk | HostNo {
  const url = parsed(baseUrl, SAXO_SIM_DEFAULT);
  if (!url) return { ok: false };
  if (local(url)) return { ok: true, base: url.toString().replace(/\/$/, "") };
  const sim = url.protocol === "https:" && url.hostname === "gateway.saxobank.com" && url.pathname.startsWith("/sim");
  if (!sim) return { ok: false };
  return { ok: true, base: url.toString().replace(/\/$/, "") };
}

export function coinbaseSandboxBase(baseUrl: string): HostOk | HostNo {
  const url = parsed(baseUrl, COINBASE_SANDBOX_DEFAULT);
  if (!url) return { ok: false };
  if (local(url)) return { ok: true, base: url.toString().replace(/\/$/, "") };
  const sandbox = url.protocol === "https:" && url.hostname === "api-public.sandbox.exchange.coinbase.com";
  if (!sandbox) return { ok: false };
  return { ok: true, base: url.toString().replace(/\/$/, "") };
}
