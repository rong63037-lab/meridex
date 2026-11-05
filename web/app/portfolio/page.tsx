"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { formatQtyWithUnit } from "@/lib/qty";
import { deskCopy } from "@/lib/desk-copy";
import { reasonText, useI18n } from "@/lib/i18n";

type Order = {
  engine_order_id: string;
  symbol?: string;
  side: string;
  order_type: string;
  price_cents: string | null;
  qty_mg: string;
  leaves_mg: string;
  filled_mg: string;
  status: string;
  reject_reason: string | null;
  created_at: string;
};
type Trade = {
  engine_trade_id: string;
  symbol?: string;
  price_cents: string;
  qty_mg: string;
  notional_uusd: string;
  userSide: string;
  fee_uusd?: string | null;
  tape_at: string;
};

export default function PortfolioPage() {
  const { t, lang } = useI18n();
  const copy = deskCopy(lang);
  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };
  const [orders, setOrders] = useState<Order[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState("");

  function load() {
    api<Order[]>("/api/orders").then(setOrders).catch((err) => setError(reasonText(lang, (err as Error).message)));
    api<Trade[]>("/api/trades").then(setTrades).catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  return (
    <Shell>
      <div className="page">
        {error ? <p className="err">{error}</p> : null}
        <div className="panel">
          <h2>{t.myOrders}</h2>
          {orders.length === 0 ? <p className="hint">{copy.emptyOrders}</p> : (
          <div className="table-wrap"><table className="table">
            <thead>
              <tr><th>{t.time}</th><th>{t.side}</th><th>{t.type}</th><th>{t.price}</th><th>{t.qty}</th><th>{t.filled}</th><th>{t.status}</th><th></th></tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.engine_order_id}>
                  <td>{timeLabel(order.created_at)}</td>
                  <td className={order.side === "buy" ? "bid" : "ask"}>{order.side}</td>
                  <td>{order.order_type}</td>
                  <td>{order.price_cents ? centsToUsd(order.price_cents) : "—"}</td>
                  <td>{formatQtyWithUnit(order.symbol || "XAU/USD", order.qty_mg, words)}</td>
                  <td>{formatQtyWithUnit(order.symbol || "XAU/USD", order.filled_mg, words)}</td>
                  <td>{order.status}{order.reject_reason ? ` · ${reasonText(lang, order.reject_reason)}` : ""}</td>
                  <td>
                    {order.status === "open" ? (
                      <Button size="sm" variant="outline" onClick={() => api(`/api/orders/${order.engine_order_id}/cancel`, { method: "POST" }).then(load)}>
                        {t.cancel}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          )}
        </div>
        <div className="panel">
          <h2>{t.myTrades}</h2>
          {trades.length === 0 ? <p className="hint">{copy.emptyTrades}</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t.time}</th><th>{t.side}</th><th>{t.price}</th><th>{t.qty}</th><th>{t.est}</th><th>{t.fee}</th></tr></thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.engine_trade_id}>
                  <td>{timeLabel(trade.tape_at)}</td>
                  <td className={trade.userSide === "buy" ? "bid" : "ask"}>{trade.userSide}</td>
                  <td>{centsToUsd(trade.price_cents)}</td>
                  <td>{formatQtyWithUnit(trade.symbol || "XAU/USD", trade.qty_mg, words)}</td>
                  <td>{formatUsd(trade.notional_uusd)}</td>
                  <td>{trade.fee_uusd ? formatUsd(trade.fee_uusd) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          )}
        </div>
      </div>
    </Shell>
  );
}
