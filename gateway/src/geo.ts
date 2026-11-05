import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyRequest } from "fastify";

const here = dirname(fileURLToPath(import.meta.url));
const ipMap = JSON.parse(readFileSync(join(here, "../config/geoip-mock.json"), "utf8")) as Record<
  string,
  string
>;

export function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.ip || "";
}

/** Sandbox GeoIP. X-Mock-Country is honored only when SANDBOX_MOCK_GEO=1. */
export function lookupCountry(req: FastifyRequest): string {
  if (process.env.SANDBOX_MOCK_GEO !== "0") {
    const header = req.headers["x-mock-country"];
    if (typeof header === "string" && /^[A-Za-z]{2}$/.test(header)) return header.toUpperCase();
  }
  const ip = clientIp(req);
  return ipMap[ip] ?? "ZZ";
}

