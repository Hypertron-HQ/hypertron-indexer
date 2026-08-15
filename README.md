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
