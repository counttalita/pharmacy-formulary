#!/bin/sh
set -eu
# Build the stack, exercise the isolated database, then run browser regressions.
docker compose up -d --build --wait
docker compose exec -T api pytest -q
docker compose exec -T api python -m app.seed
docker compose --profile test run --build --rm browser-tests
