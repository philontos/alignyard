#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository"
if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and configure Google OAuth first." >&2
  exit 1
fi
if [ ! -f dist/runner/stable/darwin-arm64/alignyard-runner.tar.gz ] \
   && [ ! -f dist/runner/stable/darwin-x64/alignyard-runner.tar.gz ]; then
  echo "Warning: no macOS Runner artifact in dist/runner; the Web install command will return 404." >&2
fi

docker compose up -d --build
attempt=0
until curl -fsS http://127.0.0.1:4500/healthz >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker compose logs --tail=100 alignyard >&2
    exit 1
  fi
  sleep 1
done
docker compose ps
echo "Alignyard is healthy on http://127.0.0.1:4500"
