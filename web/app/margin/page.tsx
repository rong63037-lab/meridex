"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd } from "@/lib/format";
import { useI18n, reasonText } from "@/lib/i18n";
import { DeskLoading } from "@/components/ComingSoon";
import { LiveDesk } from "@/components/LiveDesk";
import { fillTemplate } from "@/lib/qty";
import { usePaperMode } from "@/lib/usePaper";

type View = {
  mode: "cross" | "isolated";
  leverage: number;
  borrowedUusd: string;
  equityUusd: string;
  marginRatio: number | null;
  liquidationPrice: string | null;
  mark: string;
  blocked: string | null;
  usHard: boolean;
  badge: string;
};

export default function MarginPage() {
  const { t, lang } = useI18n();
  const { paper, ready } = usePaperMode();
  const [view, setView] = useState<View | null>(null);
  const [mode, setMode] = useState<"cross" | "isolated">("cross");
  const [lev, setLev] = useState(3);
  const [amount, setAmount] = useState("1000.00");
  const [error, setError] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [confirmBorrow, setConfirmBorrow] = useState(false);

  function load() {
    api<View>("/api/margin")
      .then((res) => {
        setView(res);
        setMode(res.mode);
        setLev(res.leverage);
      })
      .catch((err) => setError(reasonText(lang, (err as Error).message)));
  }
  useEffect(() => { if (paper) load(); }, [paper]);
  useEffect(() => { setAdvanced(localStorage.getItem("meridex.liveAdvanced") === "1"); }, []);

  const locked = Boolean(view?.blocked);
  async function saveMode() {
    setError("");
    try {
      await api("/api/margin", { method: "POST", body: JSON.stringify({ mode, leverage: lev }) });
      load();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }
  async function cash(path: "borrow" | "repay") {
    setError("");
    try {
      await api(`/api/margin/${path}`, { method: "POST", body: JSON.stringify({ amount }) });
      load();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  if (!ready) return <DeskLoading />;
  if (!paper) return <LiveDesk product="margin" />;

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <span className="sim-flag">{t.licenceBadge}</span>
          <h1>{t.marginTitle}</h1>
          <p className="hint">{t.marginBody}</p>
          <p className="hint">{t.marginWarn}</p>
          <p className="paper-banner">{t.paperBanner}</p>
          {view?.usHard ? <p className="err">{t.marginHardUs}</p> : null}
        </section>
        <section className="split">
          <div className="panel simple-order">
            <label>{fillTemplate(t.levWord, { n: String(advanced ? lev : Math.min(Math.max(lev, 1), 3)) })}</label>
            <input type="range" min={1} max={advanced ? 10 : 3} value={advanced ? lev : Math.min(Math.max(lev, 1), 3)} onChange={(e) => setLev(Number(e.target.value))} />
            <p className="simple-risk">{t.levRisk}</p>
            {view?.liquidationPrice ? <p className="hint">{fillTemplate(t.liqPlain, { px: centsToUsd(view.liquidationPrice) })}</p> : null}
            <label>{t.simpleAmount}</label>
            <input className="desk-input amount-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            {error ? <p className="err">{error}</p> : null}
            <Button className="simple-go" disabled={locked} onClick={() => setConfirmBorrow(true)}>{t.marginBorrow}</Button>
            {confirmBorrow ? (
              <div className="modal-back" onClick={() => setConfirmBorrow(false)}>
                <div className="modal" role="alertdialog" onClick={(e) => e.stopPropagation()}>
                  <h2>{t.confirmTrade}</h2>
                  <p>{t.marginBorrow} {amount}</p>
                  <div className="btn-row">
                    <Button variant="outline" onClick={() => setConfirmBorrow(false)}>{t.cancel}</Button>
                    <Button onClick={() => { setConfirmBorrow(false); void saveMode(); void cash("borrow"); }}>{t.confirmGo}</Button>
                  </div>
                </div>
              </div>
            ) : null}
            <button type="button" className="advanced-toggle" aria-expanded={advanced} onClick={() => { const next = !advanced; setAdvanced(next); localStorage.setItem("meridex.liveAdvanced", next ? "1" : "0"); }}>{t.simpleAdvanced}</button>
            {advanced ? (
              <div className="simple-advanced">
                <div className="tf">
                  <button type="button" className={mode === "cross" ? "on" : ""} onClick={() => setMode("cross")}>{t.marginCross}</button>
                  <button type="button" className={mode === "isolated" ? "on" : ""} onClick={() => setMode("isolated")}>{t.marginIsolated}</button>
                </div>
                <Button variant="outline" disabled={locked} onClick={() => void saveMode()}>{t.saveAccess}</Button>
                <Button variant="outline" disabled={locked} onClick={() => void cash("repay")}>{t.marginRepay}</Button>
              </div>
            ) : null}
          </div>
          <aside className="panel">
            <div className="hint">{t.perpMark} XAU</div>
            <div className="px">{view ? centsToUsd(view.mark) : "—"}</div>
            <p>{t.equity} <b className="num">{view ? formatUsd(view.equityUusd) : "—"}</b></p>
            <p>{t.marginBorrow} <b className="num">{view ? formatUsd(view.borrowedUusd) : "—"}</b></p>
            <p>{t.marginRatio} <b className="num">{view?.marginRatio == null ? "—" : view.marginRatio.toFixed(2)}</b></p>
            <p>{t.marginLiq} <b className="num">{view?.liquidationPrice ? centsToUsd(view.liquidationPrice) : "—"}</b></p>
          </aside>
        </section>
      </div>
    </Shell>
  );
}
