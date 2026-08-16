# hypertron-indexer

Always-on NestJS service that records privacy-pool Merkle leaves, encrypted note
blobs, and spent nullifiers, then serves them to browsers rebuilding membership
proofs.

- Port: **4002**
- DB: Atlas `hypertron_indexer` (`indexer_svc`)
- Redis: leaf cache + root history (32)

## Quick start

```bash
cp .env.example .env   # fill DATABASE_URL, INDEXER_START_LEDGER
npm install
npx prisma db push
npm run start:dev
```

After a pool **redeploy**, set `INDEXER_START_LEDGER` to the deploy ledger and
start the indexer before any deposits.

Optional: set `MERKLE_WASM_DIR` to `../hypertron-contracts/prover-wasm/pkg` so
root verification recomputes Poseidon roots via `merkle_root` (rebuild wasm with
`bash ../hypertron-contracts/prover-wasm/build.sh`).

## HTTP

| Route | Purpose |
|-------|---------|
| `GET /v1/pool/:network/leaves?since=0` | Ordered `0x` leaves (prefix from `since`) |
| `GET /v1/pool/:network/blobs?since=<ledger>` | Encrypted note blobs |
| `GET /v1/pool/:network/nullifiers` | Spent nullifiers |
| `GET /v1/pool/:network/status` | Cursor, size, root, healthy |
| `GET /health` | Process + DB |

## Probe events

```bash
npm run probe:events
```

See [docs/event-layout.md](docs/event-layout.md).

## Render

`render.yaml` contains the Node 20 build/start commands, Oregon region, health
check, current testnet deployment manifest, and the private Render Valkey URL.
Create the web service from that Blueprint, then enter the two dashboard-only
values:

- `DATABASE_URL`: Atlas URI for the dedicated `hypertron_indexer` database.
- `CORS_ORIGINS`: comma-separated frontend origins, without trailing slashes.

The service uses Render's injected `PORT`; do not add a fixed production port.
The Valkey service and web service must remain in the same Render region for the
private `red-da10qfm1egvs739nocgg` hostname to resolve.

If configuring the service manually instead of using the Blueprint:

```text
Build Command: npm ci --include=dev && npm run build
Start Command: npm start
Health Check Path: /health
```
