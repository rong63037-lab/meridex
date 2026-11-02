FROM node:22-bookworm-slim
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json* ./gateway/
WORKDIR /app/gateway
RUN npm install
COPY gateway /app/gateway
COPY db /app/db
ENV GATEWAY_PORT=7108 \
    GATEWAY_HOST=0.0.0.0 \
    ENGINE_URL=http://engine:7109 \
    DATABASE_URL=postgres://meridex:<redacted>@postgres:5432/meridex \
    SEED_DEMO=1 \
    BOTS=1 \
    SANDBOX_MOCK_GEO=1
EXPOSE 7108
CMD ["npx", "tsx", "src/index.ts"]
