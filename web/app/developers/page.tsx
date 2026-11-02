"use client";

import { useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { useI18n } from "@/lib/i18n";
import { tri } from "@/lib/tri";

const curl = `curl -s http://127.0.0.1:4317/api/v1/market/book?symbol=XAU/USD

# private: HMAC-SHA256 of
# timestamp + newline + METHOD + newline + path + newline + sha256(body)
curl -s http://127.0.0.1:4317/api/v1/balances \\
  -H "X-API-KEY: $KEY_ID" \\
  -H "X-API-TIMESTAMP: $TS" \\
  -H "X-API-SIGN: $SIGN"`;

const python = `import hashlib, hmac, time, requests
ts = str(int(time.time() * 1000))
path = "/api/v1/balances"
body = ""
payload = f"{ts}\\nGET\\n{path}\\n{hashlib.sha256(body.encode()).hexdigest()}"
sign = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
requests.get("http://127.0.0.1:4317" + path, headers={
  "X-API-KEY": key_id, "X-API-TIMESTAMP": ts, "X-API-SIGN": sign,
})`;

const js = `const ts = String(Date.now());
const path = "/api/v1/orders";
const body = JSON.stringify({ symbol: "XAU/USD", side: "buy", type: "limit", price: "130.00", quantity: "0.010" });
const payload = ts + "\\nPOST\\n" + path + "\\n" + await sha256(body);
const sign = await hmac(secret, payload);
await fetch(path, { method: "POST", body, headers: {
  "content-type": "application/json",
  "X-API-KEY": keyId, "X-API-TIMESTAMP": ts, "X-API-SIGN": sign,
}});`;

export default function DevelopersPage() {
  const { lang } = useI18n();
  const [spec, setSpec] = useState("");

  useEffect(() => {
    fetch("/api/openapi.json").then((r) => r.json()).then((data) => setSpec(JSON.stringify(data, null, 2))).catch(() => undefined);
  }, []);

  return (
    <Shell>
      <div className="page">
        <section className="panel">
          <div className="kicker">OpenAPI</div>
          <h1>{tri(lang, "MERIDEX 开放接口", "MERIDEX API", "API MERIDEX")}</h1>
          <p className="hint">{tri(
            lang,
            "MERIDEX 沙盒接口。行情公开。私有接口用 HMAC。权限只有 read 和 trade，出金不在权限里。密钥只显示一次，可以绑 IP。",
            "MERIDEX sandbox API. Public market data is open. Private routes need an HMAC key. Scopes are read and trade. Withdraw is refused.",
            "API kotak pasir MERIDEX. Data pasaran awam terbuka. Laluan peribadi perlukan kunci HMAC. Skop hanya baca dan dagangan. Pengeluaran ditolak.",
          )}</p>
        </section>
        <section className="panel">
          <h2>curl</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{curl}</pre>
        </section>
        <section className="panel">
          <h2>Python</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{python}</pre>
        </section>
        <section className="panel">
          <h2>JavaScript</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{js}</pre>
          <p className="hint">{tri(
            lang,
            "WebSocket：ws://127.0.0.1:4317/ws?apiKey=&ts=&sign= ，载荷与 GET /ws 相同。",
            "WebSocket: ws://127.0.0.1:4317/ws?apiKey=&ts=&sign= with the same payload using GET and path /ws.",
            "WebSocket: ws://127.0.0.1:4317/ws?apiKey=&ts=&sign= dengan muatan yang sama, kaedah GET dan laluan /ws.",
          )}</p>
        </section>
        <section className="panel">
          <h2>openapi.json</h2>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{spec}</pre>
        </section>
      </div>
    </Shell>
  );
}
