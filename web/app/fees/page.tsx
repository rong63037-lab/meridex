"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AccountSlot } from "@/components/AccountSlot";
import { api } from "@/lib/api";
import { formatUsd } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { liveNumber, liveNumbers } from "@/lib/live-copy";

type Tier = { product: string; tier: number; min_volume_uusd: string; maker_bps: number; taker_bps: number };
type Me = { tier: number; maker: number; taker: number; volumeUusd: string } | null;
type View = { tiers: Tier[]; spot: Me; perp: Me; margin: string };

function pct(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

export default function FeesPage() {
  const { t } = useI18n();
  const [data, setData] = useState<View | null>(null);
  const [error, setError] = useState("");
  const ready = Object.keys(liveNumbers()).length > 0;
  useEffect(() => {
    api<View>("/api/fees").then(setData).catch((err) => setError((err as Error).message));
  }, []);
  const spot = (data?.tiers ?? []).filter((row) => row.product === "spot");
  const perp = (data?.tiers ?? []).filter((row) => row.product === "perp");
  return (
    <>
      <div className="announce">{t.announcements}</div>
      <header className="topnav"><Link href="/" className="brand"><span className="mark" /> MERIDEX</Link><AccountSlot /></header>
      <section className="section">
        <h2>{t.feeTier}</h2>
        <p className="lede">{t.feeNewFills} {t.marginUsesSpot}</p>
        {error ? <p className="err">{error}</p> : null}
        {!data && !error ? <p className="hint">{t.loading}</p> : null}
        <Schedule title={t.spotSchedule} rows={spot} mine={data?.spot ?? null} maker={t.feeMaker} taker={t.feeTaker} yours={t.yourTier} />
        <Schedule title={t.perpSchedule} rows={perp} mine={data?.perp ?? null} maker={t.feeMaker} taker={t.feeTaker} yours={t.yourTier} />
        <p className="hint">
          {t.fee} {ready ? `${pct(liveNumber("convert.feeBps"))}` : "—"} · spread {ready ? liveNumber("convert.spreadBps") : "—"} bps
        </p>
        <p className="hint">
          {t.withdraw} {ready ? liveNumber("withdraw.feeUsd") : "—"} USD · {t.deposit} {ready ? liveNumber("deposit.feeUsd") : "—"} USD
        </p>
      </section>
    </>
  );
}

function Schedule({
  title, rows, mine, maker, taker, yours,
}: {
  title: string;
  rows: Tier[];
  mine: Me;
  maker: string;
  taker: string;
  yours: string;
}) {
  return (
    <div className="table-wrap" style={{ marginTop: 16 }}>
      <h3>{title}{mine ? ` · ${yours} VIP ${mine.tier} · ${maker} ${pct(mine.maker)} · ${taker} ${pct(mine.taker)}` : ""}</h3>
      <table className="table">
        <thead>
          <tr><th>VIP</th><th>30d</th><th>{maker}</th><th>{taker}</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.product}-${row.tier}`}>
              <td>VIP {row.tier}{mine && mine.tier === row.tier ? " ·" : ""}</td>
              <td className="num">{formatUsd(row.min_volume_uusd)}</td>
              <td className="num">{pct(row.maker_bps)}</td>
              <td className="num">{pct(row.taker_bps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
