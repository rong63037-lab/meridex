FROM rust:1.83-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/meridex-engine /usr/local/bin/meridex-engine
ENV ENGINE_BIND=0.0.0.0:7109 \
    ENGINE_JOURNAL=/data/journal.jsonl \
    ENGINE_FSYNC_EVERY=25
EXPOSE 7109
VOLUME ["/data"]
CMD ["meridex-engine", "serve"]
