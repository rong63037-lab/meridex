"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { EmptyMark } from "@/components/EmptyMark";
import { ComingSoon, DeskLoading } from "@/components/ComingSoon";
import { api } from "@/lib/api";
import { centsToUsd, formatUsd, timeLabel } from "@/lib/format";
import { reasonText, useI18n } from "@/lib/i18n";
import { parseUsdMicro } from "@/lib/liveQty";
import { fillTemplate, formatQtyWithUnit } from "@/lib/qty";

type Stats = {
  closes: number;
  open: number;
  followers: number;
  winRate: number | null;
  drawdownUusd: string | null;
  realizedUusd: string;
  curve: string[];
};
type Leader = { id: string; displayName: string; optedIn: boolean; stats: Stats };
type Follow = {
  id: string;
  leader_id: string;
  display_name: string | null;
  allocation_uusd: string;
  ratio_bps: number;
  max_loss_uusd: string;
  status: string;
};
type Pos = {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  entry_px: string;
  upnlUusd: string;
  realized_uusd: string;
  status: string;
  copy_follow_id: string;
  created_at: string;
};
type Board = {
  live: boolean;
  reduceOnly: boolean;
  access: string;
  maxNotionalUusd?: string;
  leaders: Leader[];
  follows: Follow[];
  positions: Pos[];
  history: Pos[];
  wallets: { spotUusd: string; marginUusd: string; derivativesUusd: string };
  me: { displayName: string; optedIn: boolean; stats: Stats } | null;
};
type Profile = Leader & { positions?: { id: string; symbol: string; side: string; status: string; realized_uusd: string }[] };

function EmptyBlock({ children }: { children: ReactNode }) {
  return (
    <div className="empty-chart">
      <EmptyMark />
      <p>{children}</p>
    </div>
  );
}

export function LiveCopy() {
  const { t, lang } = useI18n();
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [alloc, setAlloc] = useState("50.00");
  const [ratio, setRatio] = useState(100);
  const [maxLoss, setMaxLoss] = useState("25.00");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileId, setProfileId] = useState("");
  const [amount, setAmount] = useState("50.00");
  const [from, setFrom] = useState<"spot" | "derivatives">("spot");
  const [to, setTo] = useState<"spot" | "derivatives">("derivatives");
  const [stopId, setStopId] = useState("");
  const words = { gram: t.unitGram, kilogram: t.unitKg, ounce: t.unitOz };

  function load() {
    api<Board>("/api/copy")
      .then((res) => {
        setBoard(res);
        if (res.me?.displayName) setName(res.me.displayName);
        setError("");
      })
      .catch((err) => setError(reasonText(lang, (err as Error).message)))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function run(path: string, body: unknown) {
    setError("");
    setBusy(true);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      load();
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function transfer(e: FormEvent) {
    e.preventDefault();
    if (from === to) {
      setError(t.liveSameWallet);
      return;
    }
    if (!board?.live && to === "derivatives") {
      setError(t.liveTransferOut);
      return;
    }
    const parsed = parseUsdMicro(amount);
    if (!parsed.ok) {
      setError(t.liveBadAmount);
      return;
    }
    const source = from === "spot" ? board?.wallets.spotUusd : board?.wallets.derivativesUusd;
    if (source != null && parsed.micro > BigInt(source)) {
      setError(t.liveNeedWallet);
      return;
    }
    await run("/api/wallets/transfer", { from, to, amount: amount.trim() });
  }

  function nameError(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2 || trimmed.length > 40 || /[\u0000-\u001f]/.test(trimmed)) return t.liveNameLen;
    return "";
  }

  async function opt(optedIn: boolean) {
    if (optedIn) {
      const problem = nameError(name);
      if (problem) {
        setError(problem);
        return;
      }
    }
    await run("/api/copy/lead", { displayName: name.trim(), optedIn });
  }

  async function follow(leaderId: string) {
    const allocation = parseUsdMicro(alloc);
    const loss = parseUsdMicro(maxLoss);
    if (!allocation.ok || !loss.ok) {
      setError(t.liveBadAmount);
      return;
    }
    const wallet = board?.wallets.derivativesUusd ?? "0";
    const cap = board?.maxNotionalUusd ?? wallet;
    if (allocation.micro > BigInt(wallet) || allocation.micro > BigInt(cap)) {
      setError(fillTemplate(t.liveAllocNeed, { wallet: formatUsd(wallet), cap: formatUsd(cap) }));
      return;
    }
    if (loss.micro > allocation.micro) {
      setError(t.liveLossNeed);
      return;
    }
    if (ratio < 10 || ratio > 200) {
      setError(reasonText(lang, "VALIDATION"));
      return;
    }
    await run("/api/copy/follow", { leaderId, allocation: alloc.trim(), ratioBps: ratio * 100, maxLoss: maxLoss.trim() });
  }

  async function openProfile(id: string) {
    setError("");
    setProfileId(id);
    setBusy(true);
    try {
      setProfile(await api<Profile>(`/api/copy/leaders/${id}`));
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    } finally {
      setBusy(false);
      setProfileId("");
    }
  }

  if (loading && !board) return <DeskLoading label={t.liveLoadingBoard} />;
  if (board && !board.live && !board.reduceOnly) return <ComingSoon title={t.copyTitle} />;

  const statusText = (status: string) => {
    if (status === "active") return t.liveStatusActive;
    if (status === "paused") return t.liveStatusPaused;
    if (status === "stopped") return t.liveStatusStopped;
    if (status === "open") return t.liveStatusOpen;
    if (status === "closed") return t.liveKindClose;
    if (status === "liquidated") return t.liveKindLiq;
    return status;
  };

  return (
    <Shell>
      <div className="page live-desk" aria-busy={busy}>
        <section className="panel">
          <h1>{t.copyTitle}</h1>
          {board?.live ? <p className="live-notice">{t.liveNotice}</p> : null}
          <p className="hint">{t.liveCopyBody}</p>
          {board?.reduceOnly ? <p className="live-warn">{t.liveReduce}</p> : null}
          {busy ? <p className="hint">{t.liveBusy}</p> : null}
          {error ? <p className="err" role="alert">{error}</p> : null}
        </section>

        <section className="panel">
          <h2>{t.liveDerivWallet}</h2>
          <p className="hint">{t.liveWalletHint}</p>
          <div className="cards">
            <article className="card"><h3>{t.liveSpot}</h3><div className="num">{board ? formatUsd(board.wallets.spotUusd) : "—"}</div></article>
            <article className="card"><h3>{t.liveDerivWallet}</h3><div className="num">{board ? formatUsd(board.wallets.derivativesUusd) : "—"}</div></article>
          </div>
          <form className="split" onSubmit={transfer}>
            <label>{t.liveFrom}
              <select className="desk-input" value={from} onChange={(e) => setFrom(e.target.value as "spot" | "derivatives")}>
                <option value="spot">{t.liveSpot}</option>
                <option value="derivatives">{t.liveDerivWallet}</option>
              </select>
            </label>
            <label>{t.liveTo}
              <select className="desk-input" value={to} onChange={(e) => setTo(e.target.value as "spot" | "derivatives")}>
                <option value="spot">{t.liveSpot}</option>
                <option value="derivatives">{t.liveDerivWallet}</option>
              </select>
            </label>
            <label>{t.amount}<input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
            <Button type="submit" disabled={busy}>{t.liveTransfer}</Button>
          </form>
        </section>

        <section className="panel">
          <h2>{t.liveYouLead}</h2>
          <label>{t.liveDisplayName}
            <input className="desk-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-invalid={name.trim().length > 0 && nameError(name) !== ""} />
          </label>
          <p className="hint">{t.liveNameLen}</p>
          <div className="btn-row">
            <Button type="button" onClick={() => void opt(true)} disabled={!board?.live || busy}>{t.liveOptIn}</Button>
            <Button type="button" variant="outline" onClick={() => void opt(false)} disabled={busy || !board?.me?.optedIn}>{t.liveOptOut}</Button>
          </div>
          {board?.me?.optedIn ? <p className="hint">{t.liveStatusActive}</p> : null}
          {board?.me ? <StatsLine stats={board.me.stats} t={t} /> : <p className="hint">{t.liveNoStats}</p>}
        </section>

        <section className="panel">
          <h2>{t.liveProfile}</h2>
          <div className="split">
            <label>{t.copyAlloc}<input className="desk-input" value={alloc} onChange={(e) => setAlloc(e.target.value)} inputMode="decimal" /></label>
            <label>{t.liveRatio} · {ratio}%
              <input type="range" min={10} max={200} step={10} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} />
            </label>
            <label>{t.liveMaxLoss}<input className="desk-input" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} inputMode="decimal" /></label>
          </div>
          <p className="hint">{fillTemplate(t.liveAllocNeed, {
            wallet: formatUsd(board?.wallets.derivativesUusd ?? "0"),
            cap: formatUsd(board?.maxNotionalUusd ?? "0"),
          })} {t.liveLossNeed}</p>
          {(board?.leaders.length ?? 0) === 0 ? <EmptyBlock>{t.liveNoLeaders}</EmptyBlock> : (
            <div className="cards">
              {board?.leaders.map((leader) => (
                <article key={leader.id} className="card">
                  <h3>{leader.displayName}</h3>
                  <StatsLine stats={leader.stats} t={t} />
                  <div className="btn-row">
                    <Button type="button" disabled={!board.live || busy} onClick={() => void follow(leader.id)}>{t.copyFollow}</Button>
                    <Button type="button" variant="outline" disabled={busy} onClick={() => void openProfile(leader.id)}>{profileId === leader.id ? t.liveBusy : t.liveProfile}</Button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {profile ? (
            <div className="panel">
              <h3>{profile.displayName}</h3>
              <StatsLine stats={profile.stats} t={t} />
              {(profile.positions ?? []).length === 0 ? <p className="hint">{t.liveEmptyPos}</p> : (
                <ul>
                  {profile.positions?.map((row) => (
                    <li key={row.id}>{row.symbol} · {row.side === "buy" ? t.liveLong : t.liveShort} · {statusText(row.status)} · {formatUsd(row.realized_uusd)}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <h2>{t.copyFollow}</h2>
          {(board?.follows.length ?? 0) === 0 ? <EmptyBlock>{t.copyEmpty}</EmptyBlock> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t.liveProfile}</th><th>{t.copyAlloc}</th><th>{t.liveRatio}</th><th>{t.liveMaxLoss}</th><th>{t.status}</th><th></th></tr></thead>
                <tbody>
                  {board?.follows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.display_name ?? row.leader_id}</td>
                      <td className="num">{formatUsd(row.allocation_uusd)}</td>
                      <td>{(row.ratio_bps / 100).toFixed(0)}%</td>
                      <td className="num">{formatUsd(row.max_loss_uusd)}</td>
                      <td>{statusText(row.status)}</td>
                      <td>
                        {stopId === row.id ? (
                          <div className="live-confirm" role="alertdialog">
                            <p className="live-warn">{t.liveStopAsk}</p>
                            <div className="btn-row">
                              <Button size="sm" variant="danger" disabled={busy} onClick={() => { setStopId(""); void run(`/api/copy/follows/${row.id}`, { action: "stop" }); }}>{t.liveStopFollow}</Button>
                              <Button size="sm" variant="outline" disabled={busy} onClick={() => setStopId("")}>{t.liveCancel}</Button>
                            </div>
                          </div>
                        ) : (
                          <div className="btn-row">
                            {row.status === "active" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(`/api/copy/follows/${row.id}`, { action: "pause" })}>{t.livePause}</Button> : null}
                            {row.status === "paused" ? <Button size="sm" variant="outline" disabled={busy || !board?.live} onClick={() => void run(`/api/copy/follows/${row.id}`, { action: "resume" })}>{t.liveResume}</Button> : null}
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => setStopId(row.id)}>{t.liveStopFollow}</Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>{t.liveCopied}</h2>
          {(board?.positions.length ?? 0) === 0 ? <EmptyBlock>{t.liveEmptyPos}</EmptyBlock> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t.symbol}</th><th>{t.side}</th><th>{t.qty}</th><th>{t.liveEntry}</th><th>{t.liveUnreal}</th></tr></thead>
                <tbody>
                  {board?.positions.map((row) => (
                    <tr key={row.id}>
                      <td>{row.symbol}</td>
                      <td>{row.side === "buy" ? t.liveLong : t.liveShort}</td>
                      <td>{formatQtyWithUnit(row.symbol, row.qty, words)}</td>
                      <td className="num">{centsToUsd(row.entry_px)}</td>
                      <td className={`num ${row.upnlUusd.startsWith("-") ? "down" : "up"}`}>{formatUsd(row.upnlUusd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2>{t.liveOrderHist}</h2>
          {(board?.history.length ?? 0) === 0 ? <EmptyBlock>{t.liveCopyHistEmpty}</EmptyBlock> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t.time}</th><th>{t.symbol}</th><th>{t.side}</th><th>{t.pnl}</th></tr></thead>
                <tbody>
                  {board?.history.map((row) => (
                    <tr key={row.id}>
                      <td>{timeLabel(row.created_at)}</td>
                      <td>{row.symbol}</td>
                      <td>{row.side === "buy" ? t.liveLong : t.liveShort}</td>
                      <td className="num">{formatUsd(row.realized_uusd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}

function StatsLine({ stats, t }: { stats: Stats; t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <p className="hint">
      {t.liveTrades} {stats.closes} · {t.positions} {stats.open} · {t.liveFollowers} {stats.followers}
      {stats.winRate == null ? ` · ${t.liveNoStats}` : ` · ${t.copyWin} ${Math.round(stats.winRate * 100)}% · ${t.copyDrawdown} ${formatUsd(stats.drawdownUusd ?? "0")}`}
    </p>
  );
}
