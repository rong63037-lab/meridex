"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fundsCopy } from "@/lib/funds-copy";
import { reasonText, useI18n } from "@/lib/i18n";
import { FLOW_ASSETS, withdrawNetworks, type FlowAsset } from "@/lib/wallet-flow";

function WithdrawFlow() {
  const { lang } = useI18n();
  const copy = fundsCopy(lang);
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState("");
  const [asset, setAsset] = useState<FlowAsset | null>(null);
  const [network, setNetwork] = useState("");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [stepUp, setStepUp] = useState("");
  const [step, setStep] = useState(1);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [internal, setInternal] = useState(false);

  useEffect(() => {
    api<{ isInternalTest?: boolean }>("/api/me").then((me) => {
      if (me.isInternalTest) setInternal(true);
    }).catch(() => router.push("/login"));
    const preset = (params.get("asset") ?? "").toUpperCase();
    const chosen = FLOW_ASSETS.find((item) => item.id === preset);
    if (chosen) {
      setAsset(chosen);
      setStep(2);
    }
  }, [params, router]);

  const nets = asset ? withdrawNetworks(asset.id) : [];
  const fiat = asset?.kind === "fiat";
  const filtered = FLOW_ASSETS.filter((item) => {
    const q = query.trim().toLowerCase();
    return !q || item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q);
  });

  function pickAsset(next: FlowAsset) {
    setAsset(next);
    setNetwork("");
    setError("");
    setStep(2);
  }

  async function submit() {
    if (!asset) return;
    setError("");
    try {
      const res = fiat
        ? await api<{ status?: string }>("/api/wallet/rails", { method: "POST", body: JSON.stringify({ direction: "withdraw", amount, stepUp }) })
        : await api<{ status?: string }>("/api/wallet/crypto", {
          method: "POST",
          body: JSON.stringify({ asset: asset.id, network, direction: "withdraw", amount, address, stepUp }),
        });
      setDone(res.status === "pending" ? copy.pendingReview : copy.submit);
      setStepUp("");
    } catch (err) {
      setError(reasonText(lang, (err as Error).message));
    }
  }

  if (internal) {
    return <section className="panel"><span className="internal-badge">INTERNAL TEST / 内部测试</span><p className="hint">Play money only. Withdrawals are off.</p></section>;
  }

  return (
    <>
      <ol className="step-bar">
        {[copy.chooseAsset, fiat ? copy.chooseMethod : copy.chooseNetwork, copy.details, copy.review, copy.totp].map((label, index) => (
          <li key={label} className={step === index + 1 ? "on" : ""}>{label}</li>
        ))}
      </ol>
      {error ? <p className="err">{error}</p> : null}
      {done ? <p className="hint">{done}</p> : null}

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
          <ul className="asset-list">
            {nets.map((item) => (
              <li key={item.id}>
                <button type="button" className="asset-row" onClick={() => { setNetwork(item.id); setStep(3); }}>
                  <span className="asset-main"><b>{item.id === "Bank" ? copy.bank : item.label}</b></span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="langbtn" onClick={() => setStep(1)}>{copy.back}</button>
        </section>
      ) : null}

      {step === 3 && asset ? (
        <section className="panel">
          <h1>{copy.details}</h1>
          {fiat ? null : (
            <>
              <p className="hint">{copy.whitelist} <Link href="/account/security">{copy.toSecurity}</Link></p>
              <label>{copy.address}</label>
              <input className="desk-input" value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" />
            </>
          )}
          <label>{copy.amount}{fiat ? " USD" : ` ${asset.id}`}</label>
          <input className="desk-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <div className="tf">
            <button type="button" className="langbtn" onClick={() => setStep(2)}>{copy.back}</button>
            <Button disabled={!amount || (!fiat && !address)} onClick={() => setStep(4)}>{copy.next}</Button>
          </div>
        </section>
      ) : null}

      {step === 4 && asset ? (
        <section className="panel">
          <h1>{copy.review}</h1>
          <dl className="fact-list">
            <div><dt>{copy.asset}</dt><dd>{asset.id}</dd></div>
            <div><dt>{copy.network}</dt><dd>{network === "Bank" ? copy.bank : network}</dd></div>
            {fiat ? null : <div><dt>{copy.address}</dt><dd className="num">{address}</dd></div>}
            <div><dt>{copy.amount}</dt><dd className="num">{amount}</dd></div>
            <div><dt>{copy.fee}</dt><dd>{copy.feeZero}</dd></div>
          </dl>
          <div className="tf">
            <button type="button" className="langbtn" onClick={() => setStep(3)}>{copy.back}</button>
            <Button onClick={() => setStep(5)}>{copy.next}</Button>
          </div>
        </section>
      ) : null}

      {step === 5 && asset ? (
        <section className="panel">
          <h1>{copy.totp}</h1>
          <label>{copy.totp}</label>
          <input className="desk-input" value={stepUp} onChange={(e) => setStepUp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
          <div className="tf">
            <button type="button" className="langbtn" onClick={() => setStep(4)}>{copy.back}</button>
            <Button disabled={stepUp.trim().length < 6} onClick={() => void submit()}>{copy.submit}</Button>
          </div>
        </section>
      ) : null}
    </>
  );
}

export default function WithdrawPage() {
  return (
    <Suspense fallback={<p className="hint">…</p>}>
      <WithdrawFlow />
    </Suspense>
  );
}
