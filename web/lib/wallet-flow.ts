export type FlowAsset = {
  id: string;
  mark: string;
  name: string;
  kind: "crypto" | "fiat";
};

export const FLOW_ASSETS: FlowAsset[] = [
  { id: "BTC", mark: "₿", name: "Bitcoin", kind: "crypto" },
  { id: "ETH", mark: "Ξ", name: "Ether", kind: "crypto" },
  { id: "USDT", mark: "₮", name: "Tether", kind: "crypto" },
  { id: "USD", mark: "$", name: "US Dollar", kind: "fiat" },
];

export type FlowNetwork = { id: string; label: string; confirmations: string };

export function depositNetworks(asset: string): FlowNetwork[] {
  if (asset === "BTC") return [{ id: "Bitcoin", label: "Bitcoin", confirmations: "2" }];
  if (asset === "ETH") return [{ id: "Ethereum", label: "Ethereum", confirmations: "12" }];
  if (asset === "USDT") {
    return [
      { id: "ERC20", label: "Ethereum (ERC20)", confirmations: "12" },
      { id: "TRC20", label: "Tron (TRC20)", confirmations: "20" },
    ];
  }
  if (asset === "USD") {
    return [
      { id: "Bank", label: "Bank", confirmations: "name" },
      { id: "PayNow", label: "PayNow", confirmations: "name" },
    ];
  }
  return [];
}

/** Catalog names accepted by the withdraw API. */
export function withdrawNetworks(asset: string): FlowNetwork[] {
  if (asset === "BTC") return [{ id: "Bitcoin", label: "Bitcoin", confirmations: "2" }];
  if (asset === "ETH") return [{ id: "Ethereum", label: "Ethereum", confirmations: "12" }];
  if (asset === "USDT") {
    return [
      { id: "Ethereum", label: "Ethereum (ERC20)", confirmations: "12" },
      { id: "Tron", label: "Tron (TRC20)", confirmations: "20" },
    ];
  }
  if (asset === "USD") return [{ id: "Bank", label: "Bank", confirmations: "name" }];
  return [];
}

export function canonicalDepositNetwork(asset: string, network: string): string {
  const key = network.trim().toLowerCase();
  if (asset === "USDT" && (key === "ethereum" || key === "erc20")) return "ERC20";
  if (asset === "USDT" && (key === "tron" || key === "trc20")) return "TRC20";
  if (asset === "ETH" && (key === "erc20" || key === "ethereum")) return "Ethereum";
  if (asset === "BTC" && key === "btc") return "Bitcoin";
  const hit = depositNetworks(asset).find((item) => item.id.toLowerCase() === key || item.label.toLowerCase() === key);
  return hit?.id ?? network;
}

export function canDeposit(asset: string): boolean {
  return FLOW_ASSETS.some((item) => item.id === asset);
}
