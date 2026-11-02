# Local container image only. This sandbox is not published.
FROM rust:1.83-bookworm AS engine
WORKDIR /src
COPY engine/Cargo.toml engine/Cargo.lock ./
COPY engine/instruments.json ./instruments.json
COPY engine/src ./src
RUN cargo build --release

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm install
COPY web ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=engine /src/target/release/meridex-engine /usr/local/bin/meridex-engine
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./gateway/
WORKDIR /app/gateway
RUN npm install --omit=dev
WORKDIR /app
COPY gateway /app/gateway
COPY db /app/db
COPY engine/instruments.json /app/engine/instruments.json
COPY --from=web /app /app/web
COPY ops/render-start.sh /usr/local/bin/render-start.sh
RUN chmod +x /usr/local/bin/render-start.sh
ENV NODE_ENV=production \
    SEED_DEMO=1 \
    BOTS=1 \
    SANDBOX_MOCK_GEO=1 \
    ENGINE_BIND=127.0.0.1:7109 \
    ENGINE_JOURNAL=/data/journal.jsonl \
    ENGINE_URL=http://127.0.0.1:7109 \
    GATEWAY_PORT=7108 \
    API_INTERNAL_URL=http://127.0.0.1:7108 \
    ENGINE_REF_PRICE=13000 \
    ENGINE_BAND_BPS=500 \
    ENGINE_HALT_BPS=200 \
    ENGINE_FSYNC_EVERY=25
EXPOSE 10000
CMD ["render-start.sh"]
