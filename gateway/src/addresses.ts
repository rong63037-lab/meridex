import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3";

export const PAIRS = [
  { asset: "BTC", network: "Bitcoin", min: "0.0001" },
  { asset: "ETH", network: "Ethereum", min: "0.01" },
  { asset: "USDT", network: "ERC20", min: "10" },
  { asset: "USDT", network: "TRC20", min: "1" },
] as const;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export type Pair = { asset: string; network: string };

export function canonicalPair(asset: string, network: string): Pair | null {
  const a = asset.trim().toUpperCase();
  const key = network.trim().toUpperCase();
  if (a === "BTC" && (key === "BITCOIN" || key === "BTC")) return { asset: "BTC", network: "Bitcoin" };
  if (a === "ETH" && (key === "ETHEREUM" || key === "ETH" || key === "ERC20")) return { asset: "ETH", network: "Ethereum" };
  if (a === "USDT" && (key === "ERC20" || key === "ETHEREUM")) return { asset: "USDT", network: "ERC20" };
  if (a === "USDT" && (key === "TRC20" || key === "TRON")) return { asset: "USDT", network: "TRC20" };
  return null;
}

export function normalizeAddress(address: string): string {
  const value = address.trim();
  const lower = value.toLowerCase();
  if (lower.startsWith("0x") || lower.startsWith("bc1") || lower.startsWith("tb1")) return lower;
  return value;
}

export function addressHash(address: string): string {
  return createHash("sha256").update(normalizeAddress(address)).digest("hex");
}

function b58encode(buf: Buffer): string {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < buf.length; i += 1) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

function b58decode(input: string): Buffer | null {
  const bytes = [0];
  for (const ch of input) {
    const val = B58.indexOf(ch);
    if (val < 0) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  for (const ch of input) {
    if (ch !== "1") break;
    zeros += 1;
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i];
  return out;
}

function base58Check(payload: Buffer): string {
  const check = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  return b58encode(Buffer.concat([payload, check]));
}

function base58CheckDecode(input: string): Buffer | null {
  const raw = b58decode(input.trim());
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const check = raw.subarray(raw.length - 4);
  const expect = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  if (!check.equals(expect)) return null;
  return payload;
}

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const ch of hrp) out.push(ch.charCodeAt(0) >> 5);
  out.push(0);
  for (const ch of hrp) out.push(ch.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << to) - 1;
  const out: number[] = [];
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

export function encodeSegwit(hrp: string, version: number, program: Buffer): string {
  const five = convertBits(Array.from(program), 8, 5, true);
  if (!five) throw new Error("VALIDATION");
  const data = [version, ...five];
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const checksum: number[] = [];
  for (let p = 0; p < 6; p += 1) checksum.push((mod >> (5 * (5 - p))) & 31);
  return hrp + "1" + data.concat(checksum).map((d) => BECH[d]).join("");
}

export function bech32Ok(address: string): boolean {
  const lower = address.trim().toLowerCase();
  const split = lower.lastIndexOf("1");
  if (split < 1 || split + 7 > lower.length) return false;
  const hrp = lower.slice(0, split);
  if (hrp !== "bc" && hrp !== "tb") return false;
  const data: number[] = [];
  for (const ch of lower.slice(split + 1)) {
    const idx = BECH.indexOf(ch);
    if (idx < 0) return false;
    data.push(idx);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) return false;
  const version = data[0];
  const program = convertBits(data.slice(1, -6), 5, 8, false);
  if (!program || version !== 0) return false;
  return program.length === 20 || program.length === 32;
}

function toEip55(hex40: string): string {
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(hex40.toLowerCase()))).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i += 1) {
    const ch = hex40[i].toLowerCase();
    out += parseInt(hash[i], 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

function ethOk(address: string): boolean {
  const hex = address.trim().slice(2);
  if (!/^0x[0-9a-fA-F]{40}$/i.test(address.trim()) || !/^[0-9a-fA-F]{40}$/.test(hex)) return false;
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true;
  return toEip55(hex.toLowerCase()) === `0x${hex}`;
}

function btcBase58Ok(address: string): boolean {
  const payload = base58CheckDecode(address.trim());
  if (!payload || payload.length !== 21) return false;
  return payload[0] === 0x00 || payload[0] === 0x05 || payload[0] === 0x6f || payload[0] === 0xc4;
}

function tronOk(address: string): boolean {
  const payload = base58CheckDecode(address.trim());
  return Boolean(payload && payload.length === 21 && payload[0] === 0x41);
}

export function explainAddress(asset: string, network: string, address: string): string | null {
  const pair = canonicalPair(asset, network);
  if (!pair) return "unknown network";
  const value = address.trim();
  if (!value) return "missing address";
  if (pair.network === "Bitcoin") {
    if (!(bech32Ok(value) || btcBase58Ok(value))) return "bad bitcoin checksum";
    return null;
  }
  if (pair.network === "Ethereum" || pair.network === "ERC20") {
    if (!ethOk(value)) return "bad evm checksum";
    return null;
  }
  if (!tronOk(value)) return "bad tron checksum";
  return null;
}

/** Stable dummy address for local seed and tests. Checksum is valid; nothing is funded. */
export function demoAddress(asset: string, network: string, n: number): string {
  const pair = canonicalPair(asset, network);
  if (!pair) throw new Error("VALIDATION");
  const digest = createHash("sha256").update(`meridex-pool:${pair.asset}:${pair.network}:${n}`).digest();
  const twenty = digest.subarray(0, 20);
  if (pair.network === "TRC20") return base58Check(Buffer.concat([Buffer.from([0x41]), twenty]));
  if (pair.network === "Bitcoin") return encodeSegwit("tb", 0, twenty);
  return toEip55(twenty.toString("hex"));
}

export function pairMin(asset: string, network: string): string {
  const pair = canonicalPair(asset, network);
  return PAIRS.find((item) => item.asset === pair?.asset && item.network === pair.network)?.min ?? "0";
}

export function depositGuidePath(asset: string, network: string): string {
  const pair = canonicalPair(asset, network);
  const q = new URLSearchParams({ asset: pair?.asset ?? asset, network: pair?.network ?? network });
  return `/funds/deposit?${q.toString()}`;
}
