export type NetChoice = "auto" | "btc" | "eth" | "usdt-erc20" | "usdt-trc20";

export type Draft = {
  line: number;
  text: string;
  asset: string;
  network: string;
  address: string;
  clientError: "unknown" | "evm" | "mismatch" | null;
};

const forced: Record<Exclude<NetChoice, "auto">, { asset: string; network: string; kind: "btc" | "evm" | "tron" }> = {
  btc: { asset: "BTC", network: "Bitcoin", kind: "btc" },
  eth: { asset: "ETH", network: "Ethereum", kind: "evm" },
  "usdt-erc20": { asset: "USDT", network: "ERC20", kind: "evm" },
  "usdt-trc20": { asset: "USDT", network: "TRC20", kind: "tron" },
};

export function looksLike(address: string): "btc" | "evm" | "tron" | "unknown" {
  const value = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return "evm";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return "tron";
  if (/^(bc1|tb1)/i.test(value) || /^[13mn2][1-9A-HJ-NP-Za-km-z]{24,}$/.test(value)) return "btc";
  return "unknown";
}

/** One address per line. A chosen network applies to the whole paste. Auto detects Bitcoin and TRON; Ethereum still needs ETH or USDT. */
export function parsePaste(text: string, choice: NetChoice): Draft[] {
  const out: Draft[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim();
    if (!value || value.toLowerCase() === "address") return;
    const line = index + 1;
    const kind = looksLike(value);
    if (choice === "auto") {
      if (kind === "btc") out.push({ line, text: value, asset: "BTC", network: "Bitcoin", address: value, clientError: null });
      else if (kind === "tron") out.push({ line, text: value, asset: "USDT", network: "TRC20", address: value, clientError: null });
      else if (kind === "evm") out.push({ line, text: value, asset: "", network: "", address: value, clientError: "evm" });
      else out.push({ line, text: value, asset: "", network: "", address: value, clientError: "unknown" });
      return;
    }
    const pick = forced[choice];
    if (kind !== pick.kind) {
      out.push({ line, text: value, asset: pick.asset, network: pick.network, address: value, clientError: "mismatch" });
      return;
    }
    out.push({ line, text: value, asset: pick.asset, network: pick.network, address: value, clientError: null });
  });
  return out;
}
