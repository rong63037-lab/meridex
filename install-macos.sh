#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@16/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer is intended for macOS." >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install Homebrew first: https://brew.sh" >&2
  exit 1
fi

if ! sudo -n true 2>/dev/null; then
  echo "This script needs an admin password once to accept the Xcode license and install packages."
fi

sudo xcodebuild -license accept >/dev/null 2>&1 || true

if ! command -v rustup >/dev/null 2>&1; then
  brew install rustup-init
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup-init -y
fi

if ! command -v postgres >/dev/null 2>&1; then
  brew install postgresql@16
fi

export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/opt/homebrew/opt/postgresql@16/bin:$PATH"
rustup default stable

if command -v brew >/dev/null 2>&1; then
  brew services start postgresql@16 >/dev/null 2>&1 || true
fi

createuser -s meridex 2>/dev/null || true
createdb -O meridex meridex 2>/dev/null || true

cd "$(dirname "$0")"

cargo build --manifest-path engine/Cargo.toml

for dir in gateway web web-admin web-pool; do
  if [[ -d "$dir" ]]; then
    (cd "$dir" && npm install)
  fi
done

mkdir -p data logs

cat <<'EOF'

Setup complete.

Next steps:
  ./start-local.sh

Then open:
  http://127.0.0.1:4317  (customer site)
  http://127.0.0.1:4318  (admin portal)
  http://127.0.0.1:4319  (address pool)

If the service does not start, inspect the logs in ./logs/
EOF
