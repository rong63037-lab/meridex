"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { fundsCopy } from "@/lib/funds-copy";
import { useI18n } from "@/lib/i18n";
import { canonicalDepositNetwork, depositNetworks, FLOW_ASSETS, type FlowAsset } from "@/lib/wallet-flow";

type Address = {
  asset: string;
  network: string;
  status: "ready" | "preparing";
  address: string | null;
  memo: string | null;
  min: string | null;
  qrDataUrl: string | null;
  guidePath?: string;
};
type Instructions = {
  referenceCode: string;
  fundId?: string;
  bankName: string;
  bankAccount: string;
  bankQrDataUrl?: string;
  addresses: Address[];
};
type Deposit = { id: string; asset: string; network: string | null; amount: string; status: string; created_at: string };
type Claim = { id: number; asset: string; network: string; amount: string; reference: string; status: string };

function DepositFlow() {
  const { lang } = useI18n();
  const copy = fundsCopy(lang);
  const router = useRouter();
  const params = useSearchParams();
  const presetAsset = (params.get("asset") ?? "").toUpperCase();
  const presetNet = params.get("network") ?? "";
  const [query, setQuery] = useState("");
  const [asset, setAsset] = useState<FlowAsset | null>(null);
  const [network, setNetwork] = useState("");
  const [step, setStep] = useState(1);
  const [info, setInfo] = useState<Instructions | null>(null);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [copied, setCopied] = useState("");
  const [internal, setInternal] = useState(false);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [sentRef, setSentRef] = useState("");
  const [sentAmount, setSentAmount] = useState("");
  const [sentNote, setSentNote] = useState("");
  const [sentBusy, setSentBusy] = useState(false);

  useEffect(() => {
    api<{ isInternalTest?: boolean }>("/api/me").then((me) => {
      if (me.isInternalTest) setInternal(true);
    }).catch(() => router.push("/login"));
    api<Instructions>("/api/wallet/deposit-instructions").then(setInfo).catch((err) => {
      if ((err as Error).message === "PLAY_ONLY") setInternal(true);
    });
    api<{ deposits: Deposit[] }>("/api/wallet/deposits").then((res) => setDeposits(res.deposits ?? [])).catch(() => undefined);
    api<{ claims: Claim[] }>("/api/wallet/deposit-claims").then((res) => setClaims(res.claims ?? [])).catch(() => undefined);
  }, [router]);

  useEffect(() => {
    const chosen = FLOW_ASSETS.find((item) => item.id === presetAsset);
    if (!chosen) return;
    setAsset(chosen);
    const nets = depositNetworks(chosen.id);
    const wanted = chosen.kind === "crypto" ? canonicalDepositNetwork(chosen.id, presetNet) : presetNet;
    if (wanted && nets.some((item) => item.id === wanted)) {
      setNetwork(wanted);
      setStep(3);
    } else {
      setStep(2);
    }
  }, [presetAsset, presetNet]);

  const nets = asset ? depositNetworks(asset.id) : [];
  const net = nets.find((item) => item.id === network);
  const pool = info?.addresses.find((row) => row.asset === asset?.id && row.network === network);
  const recent = useMemo(
    () => deposits.filter((row) => !asset || row.asset === asset.id).slice(0, 5),
    [deposits, asset],
  );

  function pickAsset(next: FlowAsset) {
    setAsset(next);
    setNetwork("");
    setStep(2);
  }

  function copyText(value: string) {
    void navigator.clipboard.writeText(value);
    setCopied(value);
  }

  async function reportSent() {
    if (!asset || !network) return;
    setSentBusy(true);
    setSentNote("");
    try {
      const res = await api<{ existing?: boolean }>("/api/wallet/deposit-claims", {
        method: "POST",
        body: JSON.stringify({ asset: asset.id, network, amount: sentAmount, reference: sentRef }),
      });
      setSentNote(res.existing ? copy.sentDuplicate : copy.sentOk);
      setSentRef("");
      setSentAmount("");
      const next = await api<{ claims: Claim[] }>("/api/wallet/deposit-claims");
      setClaims(next.claims ?? []);
    } catch (err) {
      const code = (err as Error).message;
      setSentNote(code === "DUPLICATE_REFERENCE" ? copy.sentDuplicate : code);
    } finally {
      setSentBusy(false);
    }
  }

  // The in-house chat was removed from the customer site; questions go to Tawk.to (general Q&A).
  function ask() {
    const tawk = (window as Window & { Tawk_API?: { maximize?: () => void } }).Tawk_API;
    tawk?.maximize?.();
  }

  const filtered = FLOW_ASSETS.filter((item) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
  });

  const fiat = asset?.kind === "fiat";
  const showAddress = fiat ? info?.bankAccount : pool?.address;
  const qr = fiat ? info?.bankQrDataUrl : pool?.qrDataUrl;
  const fundId = info?.fundId || info?.referenceCode || "";
  const memo = fiat ? fundId : pool?.memo;

  if (internal) {
    return <section className="panel"><span className="internal-badge">INTERNAL TEST / 内部测试</span><p className="hint">Play money only. Deposits are off.</p></section>;
  }

  return (
    <>
      {fundId ? (
        <section className="panel">
          <p className="kicker">{copy.fundId}</p>
          <p className="num">{fundId}</p>
          <p className="hint">{copy.fundIdHint}</p>
        </section>
      ) : null}
      <ol className="step-bar">
        <li className={step === 1 ? "on" : ""}>{copy.chooseAsset}</li>
        <li className={step === 2 ? "on" : ""}>{fiat ? copy.chooseMethod : copy.chooseNetwork}</li>
        <li className={step === 3 ? "on" : ""}>{copy.addressStep}</li>
      </ol>

      {step === 1 ? (
        <section className="panel">
          <h1>{copy.chooseAsset}</h1>
          <input className="desk-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={copy.search} aria-label={copy.search} />
          <ul className="asset-list">
            {filtered.map((item) => (
              <li key={item.id}>
                <button type="button" className="asset-row" onClick={() => pickAsset(item)}>
                  <span className="coin" aria-hidden>{item.mark}</span>
                  <span className="asset-main"><b>{item.id}</b><span className="hint">{item.name}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {step === 2 && asset ? (
        <section className="panel">
          <h1>{fiat ? copy.chooseMethod : copy.chooseNetwork}</h1>
          <p className="hint warn-line">{fiat ? copy.nameMatch : copy.wrongNet}</p>
          <ul className="asset-list">
            {nets.map((item) => (
              <li key={item.id}>
                <button type="button" className={`asset-row ${network === item.id ? "on" : ""}`} onClick={() => { setNetwork(item.id); setStep(3); }}>
                  <span className="asset-main"><b>{item.id === "Bank" ? copy.bank : item.id === "PayNow" ? copy.paynow : item.label}</b><span className="hint">{asset.id}</span></span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="langbtn" onClick={() => setStep(1)}>{copy.back}</button>
        </section>
      ) : null}

      {step === 3 && asset && net ? (
        <section className="panel qr-hero">
          <p className="kicker">{asset.id} · {fiat ? (network === "PayNow" ? copy.paynow : copy.bank) : net.label}</p>
          <p className="safety-line">{copy.safety}</p>
          {!info || (!fiat && pool?.status !== "ready") || !showAddress ? (
            <p className="hint">{copy.preparing}</p>
          ) : (
            <>
              {qr ? <img src={qr} alt="" width={220} height={220} /> : null}
              <p className="num addr-lg">{showAddress}</p>
              <button type="button" className="desk-cta" onClick={() => copyText(showAddress)}>{copied === showAddress ? copy.copied : copy.copy}</button>
              <dl className="fact-list">
                <div><dt>{copy.memo}</dt><dd className="num">{memo || copy.noMemo} {memo ? <button type="button" className="langbtn" onClick={() => copyText(memo)}>{copy.copy}</button> : null}</dd></div>
                <div><dt>{copy.min}</dt><dd className="num">{fiat ? "10 USD" : pool?.min ?? "—"}</dd></div>
                <div><dt>{copy.conf}</dt><dd>{net.confirmations === "name" ? copy.fiatConf : net.confirmations}</dd></div>
                {fiat ? <div><dt>{copy.reference}</dt><dd className="num">{info.bankName}</dd></div> : null}
              </dl>
            </>
          )}
          <button type="button" className="langbtn" onClick={() => setStep(2)}>{copy.back}</button>
        </section>
      ) : null}

      {step === 3 && asset && network ? (
        <section className="panel">
          <h2>{copy.sentTitle}</h2>
          <p className="hint">{copy.sentHint}</p>
          <div className="sent-form">
            <label>{copy.sentRef}
              <input className="desk-input" value={sentRef} onChange={(e) => setSentRef(e.target.value)} autoComplete="off" />
            </label>
            <label>{copy.amount}
              <input className="desk-input" value={sentAmount} onChange={(e) => setSentAmount(e.target.value)} inputMode="decimal" autoComplete="off" />
            </label>
            <button type="button" className="desk-cta" disabled={sentBusy || !sentRef.trim() || !sentAmount.trim()} onClick={() => void reportSent()}>{copy.sentSubmit}</button>
          </div>
          {sentNote ? <p className="hint">{sentNote}</p> : null}
          {claims.filter((row) => row.status === "pending" && row.asset === asset.id).length ? (
            <ul className="recent-list">
              {claims.filter((row) => row.status === "pending" && row.asset === asset.id).map((row) => (
                <li key={row.id}>
                  <span><b>{row.asset}</b> {row.network} · <span className="num">{row.amount}</span> · {row.reference}</span>
                  <span className="chip warn">{copy.sentPending}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <div className="section-head">
          <h2>{copy.recent}</h2>
          <Link href="/funds/history">{copy.viewAll}</Link>
        </div>
        {recent.length === 0 ? <p className="hint">{copy.empty}</p> : (
          <ul className="recent-list">
            {recent.map((row) => (
              <li key={row.id}>
                <span><b>{row.asset}</b> {row.network ?? ""} · <span className="num">{row.amount}</span></span>
                <span className={`chip ${row.status === "credited" ? "ok" : row.status === "flagged" ? "bad" : "warn"}`}>{row.status}</span>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="text-link" onClick={ask}>{copy.missing}</button>
      </section>
    </>
  );
}

export default function DepositPage() {
  return (
    <Suspense fallback={<p className="hint">…</p>}>
      <DepositFlow />
    </Suspense>
  );
}
