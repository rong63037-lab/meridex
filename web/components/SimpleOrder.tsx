"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { fillTemplate } from "@/lib/qty";
import type { AmountMode } from "@/lib/simple-math";

type SymbolOpt = { symbol: string; label?: string };

export function SimpleOrder({
  symbols,
  symbol,
  onSymbol,
  side,
  onSide,
  buyLabel,
  sellLabel,
  amount,
  onAmount,
  amountMode,
  onAmountMode,
  unit,
  onPct,
  pay,
  receive,
  fee,
  funds,
  error,
  busy,
  goLabel,
  onGo,
  confirmOpen,
  confirmBody,
  onConfirmYes,
  onConfirmNo,
  leverage,
  liq,
  risk,
  advanced,
  advancedOpen,
  onAdvanced,
  inputId = "simple-amount",
}: {
  symbols?: SymbolOpt[];
  symbol: string;
  onSymbol?: (symbol: string) => void;
  side: "buy" | "sell";
  onSide: (side: "buy" | "sell") => void;
  buyLabel: string;
  sellLabel: string;
  amount: string;
  onAmount: (value: string) => void;
  amountMode: AmountMode;
  onAmountMode: (mode: AmountMode) => void;
  unit: string;
  onPct: (pct: number) => void;
  pay: string;
  receive: string;
  fee: string;
  funds?: boolean;
  error?: string;
  busy?: boolean;
  goLabel: string;
  onGo: () => void;
  confirmOpen: boolean;
  confirmBody: string;
  onConfirmYes: () => void;
  onConfirmNo: () => void;
  leverage?: { value: number; min: number; max: number; onChange: (n: number) => void };
  liq?: string;
  risk?: string;
  advanced?: ReactNode;
  advancedOpen?: boolean;
  onAdvanced?: (open: boolean) => void;
  inputId?: string;
}) {
  const { t } = useI18n();
  const [hint, setHint] = useState(false);
  useEffect(() => {
    setHint(localStorage.getItem("meridex.simpleHint") !== "off");
  }, []);

  return (
    <div className="simple-order" data-testid="simple-order">
      {hint ? (
        <div className="simple-hint" data-testid="trade-hint" role="note">
          <strong>{t.hintTradeTitle}</strong>
          <ol>
            <li>{t.hintTrade1}</li>
            <li>{t.hintTrade2}</li>
            <li>{t.hintTrade3}</li>
          </ol>
          <button
            type="button"
            onClick={() => {
              localStorage.setItem("meridex.simpleHint", "off");
              setHint(false);
            }}
          >
            {t.hintTradeDismiss}
          </button>
        </div>
      ) : null}
      {symbols && symbols.length > 1 && onSymbol ? (
        <label className="simple-asset">
          <span>{t.pickAsset}</span>
          <select className="desk-input" aria-label={t.pickAsset} value={symbol} onChange={(e) => onSymbol(e.target.value)}>
            {symbols.map((item) => (
              <option key={item.symbol} value={item.symbol}>{item.label || item.symbol}</option>
            ))}
          </select>
        </label>
      ) : (
        <p className="simple-asset"><span>{t.pickAsset}</span> <b>{symbol}</b></p>
      )}
      <div className="side-toggle simple-side">
        <button type="button" data-testid="simple-buy" className={`buy ${side === "buy" ? "on" : ""}`} onClick={() => onSide("buy")}>{buyLabel}</button>
        <button type="button" data-testid="simple-sell" className={`sell ${side === "sell" ? "on" : ""}`} onClick={() => onSide("sell")}>{sellLabel}</button>
      </div>
      <div className="amount-mode" role="group" aria-label={t.simpleAmount}>
        <button type="button" data-testid="amount-usd" className={amountMode === "usd" ? "on" : ""} onClick={() => onAmountMode("usd")}>{t.amtUsd}</button>
        <button type="button" data-testid="amount-qty" className={amountMode === "qty" ? "on" : ""} onClick={() => onAmountMode("qty")}>{t.amtQty} ({unit})</button>
      </div>
      <label htmlFor={inputId}>{t.simpleAmount}</label>
      <input
        id={inputId}
        data-testid="simple-amount"
        className="desk-input amount-input"
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
      />
      <div className="pct">
        {[0.25, 0.5, 0.75, 1].map((pct) => (
          <button key={pct} type="button" onClick={() => onPct(pct)}>{pct * 100}%</button>
        ))}
      </div>
      {leverage ? (
        <label className="simple-lev">
          <span>{fillTemplate(t.levWord, { n: String(leverage.value) })}</span>
          <input
            type="range"
            min={leverage.min}
            max={leverage.max}
            step={1}
            value={leverage.value}
            aria-label={fillTemplate(t.levWord, { n: String(leverage.value) })}
            onChange={(e) => leverage.onChange(Number(e.target.value))}
          />
        </label>
      ) : null}
      <p className="simple-estimate" data-testid="simple-estimate">
        {t.youPay} {pay} · {t.youReceive} {receive} · {t.fee} {fee}
      </p>
      {liq ? <p className="hint">{liq}</p> : null}
      {risk ? <p className="simple-risk">{risk}</p> : null}
      {funds ? (
        <p className="err" role="alert">{t.needDeposit} <a href="/funds/deposit">{t.goDeposit}</a></p>
      ) : error ? <p className="err" role="alert">{error}</p> : null}
      <Button data-testid="simple-go" className="ticket-submit simple-go" variant={side === "buy" ? "desk" : "danger"} disabled={busy} onClick={onGo}>
        {goLabel}
      </Button>
      {onAdvanced ? (
        <button type="button" className="advanced-toggle" data-testid="advanced-toggle" aria-expanded={Boolean(advancedOpen)} onClick={() => onAdvanced(!advancedOpen)}>
          {t.simpleAdvanced}
        </button>
      ) : null}
      {advancedOpen ? <div className="simple-advanced">{advanced}</div> : null}
      {confirmOpen ? (
        <div className="modal-back" onClick={onConfirmNo}>
          <div className="modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <h2>{t.confirmTrade}</h2>
            <p>{confirmBody}</p>
            <p className="simple-estimate">{t.youPay} {pay} · {t.youReceive} {receive} · {t.fee} {fee}</p>
            <div className="btn-row">
              <Button variant="outline" onClick={onConfirmNo}>{t.cancel}</Button>
              <Button data-testid="confirm-yes" onClick={onConfirmYes}>{t.confirmGo}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
