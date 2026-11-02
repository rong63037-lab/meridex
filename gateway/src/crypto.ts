import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPH[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPH[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = ALPH.indexOf(c);
    if (idx < 0) throw new Error("BAD_BASE32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 6238 TOTP, HMAC-SHA1, 30 second step. */
export function hotp(secret: string, counter: bigint, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

export function totp(secret: string, at = Date.now(), digits = 6, step = 30): string {
  const counter = BigInt(Math.floor(at / 1000 / step));
  return hotp(secret, counter, digits);
}

export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const cleaned = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  const now = Date.now();
  const given = Buffer.from(cleaned);
  for (let w = -window; w <= window; w++) {
    const expect = Buffer.from(totp(secret, now + w * 30_000));
    if (expect.length === given.length && timingSafeEqual(expect, given)) return true;
  }
  return false;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const hash = scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  if (hash.length !== expected.length) return false;
  return timingSafeEqual(hash, expected);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export type Portal = "customer" | "staff" | "pool";

export type JwtPayload = {
  sub: string;
  email: string;
  role: string;
  amr: string[];
  exp: number;
  sid?: string;
  portal?: Portal;
};

export function signJwt(payload: Omit<JwtPayload, "exp">, secret: string, ttlSec = 60 * 60 * 12): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(
    Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })),
  );
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${h}.${b}`).digest());
  const got = Buffer.from(s);
  const expBuf = Buffer.from(expected);
  if (got.length !== expBuf.length || !timingSafeEqual(got, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, "base64url").toString()) as JwtPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!Array.isArray(payload.amr) || !payload.amr.includes("totp")) return null;
    return payload;
  } catch {
    return null;
  }
}
