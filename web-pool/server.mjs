import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { parse } from "node:url";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.POOL_HOST || process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4319);
const api = new URL(process.env.API_INTERNAL_URL || "http://127.0.0.1:7108");

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function proxy(req, res) {
  const headers = { ...req.headers, host: api.host };
  const preq = httpRequest(
    { hostname: api.hostname, port: api.port, path: req.url, method: req.method, headers },
    (pres) => {
      res.writeHead(pres.statusCode || 502, pres.headers);
      pres.pipe(res);
    },
  );
  preq.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "GATEWAY_UNAVAILABLE" }));
  });
  req.pipe(preq);
}

function secure(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
  );
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    secure(res);
    const url = req.url || "/";
    if (url.startsWith("/api/") && !url.startsWith("/api/pool")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    if (url.startsWith("/api/pool") || url.startsWith("/healthz")) {
      proxy(req, res);
      return;
    }
    handle(req, res, parse(url, true));
  });
  server.listen(port, hostname, () => {
    console.log(`meridex-pool http://${hostname}:${port}`);
  });
});
