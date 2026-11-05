"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatUsd, timeLabel } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type Point = { day: string; equityUusd: string };
type Slice = { category: string; usdUusd: string };
type Activity = { id: string; kind: string; asset: string; amount: string; detail: string; at: string };
type View = {
  namespace: "real" | "paper";
  enabled: boolean;
  equityUusd: string;
  cashUusd: string;
  pnlUusd: string;
  curve: Point[];
  allocation: Slice[];
  activity: Activity[];
};

const COLORS: Record<string, string> = {
  cash: "#8b97a6",
  metal: "#e0b15a",
  crypto: "#6ea8fe",
  commodity: "#d98a3a",
  fx: "#3dbea0",
  other: "#c07bff",
};

export function PortfolioHome() {
  const { t } = useI18n();
  const [ns, setNs] = useState<"real" | "paper">("real");
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setView(null);
    setError("");
    api<View>(`/api/account/portfolio?namespace=${ns}`)
      .then(setView)
      .catch((err) => setError((err as Error).message));
  }, [ns]);

  const labels: Record<string, string> = {
    cash: t.cash,
    metal: t.catMetal,
    crypto: t.catCrypto,
    commodity: t.catCommodity,
    fx: t.catFx,
    other: t.allocation,
  };
  const pnl = BigInt(view?.pnlUusd ?? "0");
  const emptyPaper = ns === "paper" && view && !view.enabled && view.equityUusd === "0";

  return (
    <section className="overview">
      <div className="panel">
        <div className="tabs">
          <button type="button" className={ns === "real" ? "on" : ""} onClick={() => setNs("real")}>{t.realNamespace}</button>
          <button type="button" className={ns === "paper" ? "on" : ""} onClick={() => setNs("paper")}>{t.paperNamespace}</button>
        </div>
        {error ? <p className="err">{error}</p> : null}
        {!view ? <div className="skeleton" style={{ height: 160 }} /> : emptyPaper ? <p className="hint">{t.paperEmpty}</p> : (
          <>
            <p className="kicker">{t.equity}</p>
            <p className="equity-num">{formatUsd(view.equityUusd)}</p>
            <p className={pnl >= 0n ? "up" : "down"}>{t.pnl} {pnl >= 0n ? "+" : ""}{formatUsd(view.pnlUusd)} · {t.cash} {formatUsd(view.cashUusd)}</p>
            <h2 style={{ marginTop: 14 }}>{t.pnlCurve}</h2>
            <Curve points={view.curve} />
            <div className="curve-scale">
              <span>{view.curve[0]?.day}</span>
              <span>{view.curve[view.curve.length - 1]?.day}</span>
            </div>
          </>
        )}
      </div>
      <div className="panel">
        <h2>{t.allocation}</h2>
        {view && !emptyPaper ? <Donut slices={view.allocation} labels={labels} /> : <div className="skeleton" style={{ height: 120 }} />}
        <h2 style={{ marginTop: 16 }}>{t.activityRecent}</h2>
        {view && view.activity.length === 0 ? <p className="hint">{t.noActivity}</p> : null}
        <ul className="activity-list">
          {(view?.activity ?? []).map((row) => (
            <li key={row.id}>
              <span>{timeLabel(row.at)}</span>
              <span>{row.kind}</span>
              <span className="hint">{row.detail || row.asset}</span>
              <b className="num">{row.asset === "USD" || row.kind === "paper_fill" ? formatUsd(row.amount) : row.amount}</b>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Curve({ points }: { points: Point[] }) {
  if (points.length === 0) return null;
  const ys = points.map((point) => Number(point.equityUusd) / 1_000_000);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const w = 520;
  const h = 140;
  const pad = 8;
  const coords = ys.map((y, i) => {
    const x = pad + (points.length === 1 ? (w - pad * 2) / 2 : (i / (points.length - 1)) * (w - pad * 2));
    const py = pad + (1 - (y - min) / span) * (h - pad * 2);
    return [x, py] as const;
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  return (
    <svg className="pnl-curve" viewBox={`0 0 ${w} ${h}`} role="img">
      <path d={d} fill="none" stroke="#e0b15a" strokeWidth="2" />
      <circle cx={last[0]} cy={last[1]} r="3.5" fill="#f3d48a" />
    </svg>
  );
}

function pctLabel(fraction: number): string {
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

function Donut({ slices, labels }: { slices: Slice[]; labels: Record<string, string> }) {
  const total = slices.reduce((sum, slice) => sum + Number(slice.usdUusd), 0) || 1;
  const r = 42;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="donut-row">
      <svg viewBox="0 0 120 120" width="148" height="148" role="img">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#1c232c" strokeWidth="16" />
        {slices.map((slice) => {
          const len = (Number(slice.usdUusd) / total) * c;
          const node = (
            <circle
              key={slice.category}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={COLORS[slice.category] ?? COLORS.other}
              strokeWidth="16"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-acc}
              transform="rotate(-90 60 60)"
            />
          );
          acc += len;
          return node;
        })}
      </svg>
      <ul className="donut-legend">
        {slices.map((slice) => (
          <li key={slice.category}>
            <i style={{ background: COLORS[slice.category] ?? COLORS.other }} />
            <span>{labels[slice.category] ?? slice.category}</span>
            <b>{pctLabel(Number(slice.usdUusd) / total)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}
