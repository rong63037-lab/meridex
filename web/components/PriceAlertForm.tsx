"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/Toast";

type Alert = { id: string; symbol: string; direction: "above" | "below"; price: string; armed: boolean };

export function PriceAlertForm({ symbol, price }: { symbol: string; price: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [level, setLevel] = useState(price);
  const [rows, setRows] = useState<Alert[]>([]);

  useEffect(() => { setLevel((prev) => prev || price); }, [price]);

  function load() {
    api<Alert[]>("/api/alerts").then(setRows).catch(() => undefined);
  }

  useEffect(() => { load(); }, [symbol]);

  async function add() {
    try {
      await api("/api/alerts", { method: "POST", body: JSON.stringify({ symbol, direction, price: level }) });
      toast(`${t.priceAlert} ${symbol}`, "ok");
      load();
    } catch {
      toast(t.error, "bad");
    }
  }

  const mine = rows.filter((row) => row.symbol === symbol).slice(0, 4);

  return (
    <div className="panel alert-box">
      <h2>{t.priceAlert}</h2>
      <div className="side-toggle">
        <button type="button" className={direction === "above" ? "buy on" : ""} onClick={() => setDirection("above")}>{t.alertAbove}</button>
        <button type="button" className={direction === "below" ? "sell on" : ""} onClick={() => setDirection("below")}>{t.alertBelow}</button>
      </div>
      <label>{t.alertPrice}</label>
      <input value={level} onChange={(e) => setLevel(e.target.value)} inputMode="decimal" />
      <Button size="sm" style={{ width: "100%", marginTop: 8 }} onClick={() => void add()}>{t.addAlert}</Button>
      {mine.map((row) => (
        <div key={row.id} className="hint" style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
          <span>{row.direction === "above" ? t.alertAbove : t.alertBelow} {row.price}</span>
          <span>{row.armed ? t.alertArmed : t.alertFired}</span>
        </div>
      ))}
    </div>
  );
}
