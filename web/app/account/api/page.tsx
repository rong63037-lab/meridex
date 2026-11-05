"use client";

import { useEffect, useState } from "react";
import { AccountBack } from "@/components/AccountBack";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { accountCopy } from "@/lib/account-copy";
import { useI18n } from "@/lib/i18n";

type Key = { id: string; label: string; prefix: string; revoked: boolean };

export default function ApiKeysPage() {
  const { t, lang } = useI18n();
  const copy = accountCopy(lang);
  const [keys, setKeys] = useState<Key[]>([]);
  const [label, setLabel] = useState("desk");
  const [stepUp, setStepUp] = useState("");
  const [fresh, setFresh] = useState("");
  const [note, setNote] = useState("");

  function load() {
    api<Key[]>("/api/account/keys").then(setKeys).catch(() => undefined);
  }
  useEffect(() => { load(); }, []);

  return (
    <Shell>
      <div className="page">
        <AccountBack />
        <h1>{copy.api}</h1>
        <p className="hint"><a href="/developers">OpenAPI</a></p>
        <section className="panel">
          {note ? <p className="err">{note}</p> : null}
          <label>{copy.label}</label>
          <input className="desk-input" value={label} onChange={(e) => setLabel(e.target.value)} />
          <label>{t.totp}</label>
          <input className="desk-input" value={stepUp} onChange={(e) => setStepUp(e.target.value)} inputMode="numeric" />
          <div className="tf">
            <Button onClick={() => api<{ token: string }>("/api/account/keys", { method: "POST", body: JSON.stringify({ label, scopes: "read,trade", stepUp }) }).then((res) => { setFresh(res.token); setNote(""); load(); }).catch((err) => setNote((err as Error).message))}>{copy.create}</Button>
          </div>
          {fresh ? <p className="hint">{copy.secretOnce}<br /><code className="num">{fresh}</code></p> : null}
          <ul className="recent-list">
            {keys.map((key) => (
              <li key={key.id}>
                <span>{key.label} · <span className="num">{key.prefix}…</span></span>
                {key.revoked ? <span className="chip bad">{t.rejected}</span> : (
                  <Button size="sm" variant="outline" onClick={() => api(`/api/account/keys/${key.id}/revoke`, { method: "POST" }).then(load)}>{t.cancel}</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Shell>
  );
}
