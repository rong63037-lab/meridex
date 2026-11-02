#!/usr/bin/env bash
# Stop MERIDEX app processes (leaves Postgres running).
for p in 4319 4318 4317 7108 7109; do
  pids=$(lsof -nP -tiTCP:$p -sTCP:LISTEN 2>/dev/null); [ -n "$pids" ] && kill $pids 2>/dev/null
done
sleep 1
for p in 4319 4318 4317 7108 7109; do
  pids=$(lsof -nP -tiTCP:$p -sTCP:LISTEN 2>/dev/null); [ -n "$pids" ] && kill -9 $pids 2>/dev/null
done
echo "MERIDEX stopped (Postgres still running; stop with: brew services stop postgresql@16)"
