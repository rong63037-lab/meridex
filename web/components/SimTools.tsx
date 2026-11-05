"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fundsCopy } from "@/lib/funds-copy";
import { reasonText, useI18n } from "@/lib/i18n";
import { usePaperMode } from "@/lib/usePaper";

export function SimTools({ onDone }: { onDone?: () => void }) {
  const { lang } = useI18n();
  const copy = fundsCopy(lang);
  const { paper } = usePaperMode();
  const [coin, setCoin] = useState("BTC");
  const [network, setNetwork] = useState("Bitcoin");
  const [amount, setAmount] = useState("0.001");
  const [usd, setUsd] = useState("1000.00");
  const [product, setProduct] = useState("coin_1oz");
  const [method, setMethod] = useState<"vault_pickup" | "delivery">("vault_pickup");
  const [qty, setQty] = useState(1);
  const [error, setError] = useState("");

  if (!paper) return null;

  async function run(task: () => Promise<unknown>) {
    setError("");
    try {
      await task();
      onDone?.();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  return (
    <details className="panel sim-tools">
      <summary>{copy.demoTools}</summary>
      <p className="hint">{copy.demoHint}</p>
      {error ? <p className="err">{error}</p> : null}
      <div className="split">
        <div>
          <h2>{copy.simCrypto}</h2>
          <label>{copy.asset}</label>
          <select className="desk-input" value={coin} onChange={(e) => {
            const next = e.target.value;
            setCoin(next);
            setNetwork(next === "USDT" ? "Ethereum" : next === "ETH" ? "Ethereum" : "Bitcoin");
          }}>
            <option value="BTC">BTC</option>
            <option value="ETH">ETH</option>
            <option value="USDT">USDT</option>
          </select>
          <label>{copy.network}</label>
          <select className="desk-input" value={network} onChange={(e) => setNetwork(e.target.value)}>
            {(coin === "USDT" ? ["Ethereum", "Tron"] : coin === "ETH" ? ["Ethereum"] : ["Bitcoin"]).map((item) => <option key={item}>{item}</option>)}
          </select>
          <label>{copy.amount}</label>
          <input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <div className="tf">
            <Button onClick={() => void run(() => api("/api/wallet/crypto", { method: "POST", body: JSON.stringify({ asset: coin, network, direction: "deposit", amount }) }))}>{copy.simCrypto}</Button>
          </div>
        </div>
        <div>
          <h2>{copy.simBank}</h2>
          <label>{copy.amount} USD</label>
          <input className="desk-input" value={usd} onChange={(e) => setUsd(e.target.value)} />
          <div className="tf">
            <Button onClick={() => void run(() => api("/api/wallet/rails", { method: "POST", body: JSON.stringify({ direction: "deposit", amount: usd }) }))}>{copy.simBank}</Button>
          </div>
          <h2>{copy.redeem}</h2>
          <select className="desk-input" value={product} onChange={(e) => setProduct(e.target.value)}>
            <option value="coin_1oz">{copy.coin}</option>
            <option value="bar_100g">{copy.bar100}</option>
            <option value="bar_1000g">{copy.bar1000}</option>
          </select>
          <div className="tabs">
            <button type="button" className={method === "vault_pickup" ? "on" : ""} onClick={() => setMethod("vault_pickup")}>{copy.vaultPickup}</button>
            <button type="button" className={method === "delivery" ? "on" : ""} onClick={() => setMethod("delivery")}>{copy.delivery}</button>
          </div>
          <label>{copy.qty}</label>
          <input className="desk-input" value={qty} onChange={(e) => setQty(Number(e.target.value) || 1)} />
          <div className="tf">
            <Button variant="outline" onClick={() => void run(() => api("/api/wallet/redemptions", { method: "POST", body: JSON.stringify({ product, method, qty }) }))}>{copy.redeem}</Button>
          </div>
        </div>
      </div>
    </details>
  );
}
