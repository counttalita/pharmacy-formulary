# Run

Requires Docker with Compose. From a clean clone:

```sh
docker compose up
```

Open http://localhost:8080. API documentation: http://localhost:8080/api/docs.
Migrations run automatically; the database persists in a named volume.

# Seed

```sh
docker compose exec api python -m app.seed
```

This repeatable command loads 500 generated medicines, four rule periods each,
and 2,000 dispenses across 2,000 opaque patient references over two years.
Try medicine `SEED-0000` and patient `patient-0000`.

# Test

Run the backend and browser tests inside containers with one command:

```sh
./scripts/test.sh
```

Backend tests use a separate `pharmacy_test` database. Browser tests use the
seeded app and add one synthetic dispense per run. The first browser-test image
build downloads Chromium and its required system libraries.

To run only the backend tests against a running stack:

```sh
docker compose exec api pytest -q
```

Measure all listing endpoints after seeding:

```sh
docker compose exec api python -m app.benchmark
```

The benchmark prints latency measurements and query plans and exits unsuccessfully
if any listing's p95 reaches 300ms.
