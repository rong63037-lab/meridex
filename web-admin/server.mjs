import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { parse } from "node:url";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.ADMIN_HOST || process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4318);
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

function proxyUpgrade(req, socket, head) {
  const upstream = net.connect(Number(api.port), api.hostname, () => {
    const lines = [`GET ${req.url} HTTP/1.1`, `Host: ${api.host}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase() === "host") continue;
      if (Array.isArray(value)) value.forEach((v) => lines.push(`${key}: ${v}`));
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

function secure(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
  );
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    secure(res);
    const url = req.url || "/";
    if (url.startsWith("/_next/static/")) {
      const writeHead = res.writeHead;
      res.writeHead = function (...args) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return writeHead.apply(this, args);
      };
    }
    if (url.startsWith("/api/") && !url.startsWith("/api/admin")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    if (url.startsWith("/api/admin") || url.startsWith("/healthz")) {
      proxy(req, res);
      return;
    }
    handle(req, res, parse(url, true));
  });
  // Next registers its own upgrade listener for HMR and will answer
  // unknown paths itself. Handle /ws before those listeners run so a
  // browser handshake is not rejected with 400.
  const emit = server.emit.bind(server);
  server.emit = (event, ...args) => {
    if (event === "upgrade") {
      const req = args[0];
      if (String(req?.url || "").startsWith("/ws")) {
        proxyUpgrade(req, args[1], args[2]);
        return true;
      }
    }
    return emit(event, ...args);
  };
  server.listen(port, hostname, () => {
    console.log(`meridex-admin http://${hostname}:${port}`);
  });
});
