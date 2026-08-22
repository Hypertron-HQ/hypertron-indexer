# Hypertron Indexer (`hypertron-indexer`)

Always-on NestJS service that watches the Hypertron **privacy pool** on Stellar (Soroban), records Merkle leaves, encrypted note blobs, and spent nullifiers, then serves them to browsers that rebuild membership proofs.

The indexer cannot decrypt notes. Blobs are stored as opaque ciphertext.

| | |
| --- | --- |
| Default local port | **4002** |
| Database | MongoDB — database name **`hypertron_indexer`** (service user `indexer_svc`) |
| Cache | Redis / Valkey — ordered leaves + 32-root history |
| Package manager | **npm** (Node 20) |
| Framework | NestJS 11 + Prisma (MongoDB) + `@stellar/stellar-sdk` |

This repo does **not** share a database with `hypertron-core-backend` (`hypertron`) or `hypertron-api` (`hypertron_api`).

---

## Role in the stack

```
Soroban RPC (pool / commitment / nullifier contracts)
        |
        | poll every 5s
        v
  ingest + Merkle verify
        |
        +--> MongoDB  (commitments, note_blobs, nullifiers, cursor)
        +--> Redis    (leaf list, last 32 roots, healthy flag)
        |
        v
  GET /v1/pool/:network/*
        |
        v
  hypertron-frontend (prover WASM / membership proofs)
```

Current testnet contracts are committed in [`deployments/testnet.json`](deployments/testnet.json).

---

## Prerequisites

- Node.js **20.x**
- npm
- MongoDB URI whose path is **`/hypertron_indexer`**
- Redis (required — there is no in-memory fallback)
- Reachable Soroban RPC (`SOROBAN_RPC_URL`)
- [`deployments/testnet.json`](deployments/testnet.json) (or another manifest pointed to by `DEPLOYMENTS_PATH`)

---

## Quick start

```bash
cp .env.example .env
# Fill DATABASE_URL, REDIS_URL, INDEXER_START_LEDGER

npm install
npx prisma generate
npx prisma db push
npm run start:dev
```

Health:

```bash
curl -sS http://localhost:4002/health
curl -sS http://localhost:4002/v1/pool/testnet/status
```

After a pool **redeploy**, set `INDEXER_START_LEDGER` to the deploy ledger (or slightly before it) and start the indexer **before** any deposits. Public testnet RPC only retains roughly a day of events; starting too far back yields an empty page.

---

## Environment

Template: [`.env.example`](.env.example).

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Atlas URI for `hypertron_indexer` |
| `REDIS_URL` | yes | Local: `redis://localhost:6379`. On Render, the **private** Valkey URL |
| `DEPLOYMENTS_PATH` | yes | Default `./deployments/testnet.json` (must exist in the build) |
| `INDEXER_START_LEDGER` | yes | First ledger to scan. Current testnet tree starts near **4168760** |
| `PORT` | no | Default `4002`. Render injects `PORT` — do not hardcode it in production |
| `CORS_ORIGINS` | no | Comma-separated frontend origins, no trailing slashes |
| `SOROBAN_RPC_URL` | no | Default `https://soroban-testnet.stellar.org` |
| `DISABLE_INGEST` | no | `true` serves stored data without advancing the cursor |
| `MERKLE_WASM_DIR` | no | Optional path to prover-wasm `pkg` so root checks recompute Poseidon via `merkle_root` |
| `NODE_ENV` | no | `development` / `test` / `production` |

Optional local WASM:

```bash
# rebuild wasm, then:
MERKLE_WASM_DIR=../hypertron-contracts/prover-wasm/pkg
```

If `MERKLE_WASM_DIR` is empty, verification uses stored `rootAfter` plus the commitment contract's `root` / `size`.

---

## How ingest works

1. [`IngestScheduler`](src/modules/ingest/ingest.scheduler.ts) ticks every **5 seconds** (first tick ~2s after boot).
2. For each enabled network in `DEPLOYMENTS_PATH`, [`IngestService`](src/modules/ingest/ingest.service.ts) reads Soroban events from `lastLedger + 1` (or `INDEXER_START_LEDGER`).
3. Public RPC drops history older than ~16,000 ledgers. If the tree is empty, ingest clamps the start ledger to that retention floor so it does not skip to the chain tip with no leaves.
4. Parsed events are written to MongoDB and the Redis leaf cache is updated.

Events ingested (CAP-46 `#[contractevent]`, snake_case names):

| Event | Stored as |
| --- | --- |
| `commit_inserted` | Ordered leaf (`commitments`) + Redis list |
| `private_transfer` | Encrypted blobs (`note_1` / `note_2`) + spent nullifier |
| `unshielded` | Spent nullifier |
| `nullifier_spent` | Spent nullifier |
| `deposited` | Logged only in v1 |

Topic layout and probe notes: [`docs/event-layout.md`](docs/event-layout.md).

Merkle tree **depth is 20** and **root history is 32**. Those constants must match the commitment contract and prover — do not change them independently.

---

## HTTP API

All pool routes take `:network` from the deployments file (`testnet` today).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/pool/:network/leaves?since=0` | Ordered `0x` leaves from index `since` (inclusive slice). Also returns `size`, `root`, `healthy` |
| `GET` | `/v1/pool/:network/blobs?since=<ledger>` | Encrypted note blobs with `leafIndex` and `ledger` |
| `GET` | `/v1/pool/:network/commitments?leaves=0x...,0x...` | Lookup by leaf hex (max 100). Used for auditor disclosure (`txHash`, `ledger`, `leafIndex`) |
| `GET` | `/v1/pool/:network/nullifiers` | Spent nullifiers |
| `GET` | `/v1/pool/:network/status` | Cursor, size, root, health, depth, root-history warning |
| `GET` | `/health` | Process + MongoDB ping |

Unknown `:network` returns **404**. Invalid leaf hex on `/commitments` returns **400**.

`status.unknownRootRisk` is set when Redis already holds a full 32-root window: client proofs that use an older root will fail `UnknownRoot` until they rebuild from `/leaves`.

---

## Data model

Prisma schema: [`prisma/schema.prisma`](prisma/schema.prisma).

| Collection | Contents |
| --- | --- |
| `commitments` | Unique `(network, leafIndex)` and `(network, leaf)` |
| `note_blobs` | Ciphertext hex; indexer cannot read it |
| `nullifiers` | Unique `(network, nullifier)` |
| `indexer_cursor` | `_id` = network, `lastLedger` |

Redis keys: `pool:{network}:leaves`, `pool:{network}:roots`, `pool:{network}:healthy`.

---

## Probe events

Inspect live Soroban topics against the configured RPC and deployments file:

```bash
npm run probe:events
```

If the probe returns zero events, the deploy is likely outside the RPC retention window. Redeploy the pool and set `INDEXER_START_LEDGER` to that deploy ledger.

---

## Scripts

| Script | Action |
| --- | --- |
| `npm run start:dev` | Watch mode |
| `npm run build` | `prisma generate` + Nest build |
| `npm start` / `npm run start:prod` | `node dist/main.js` |
| `npx prisma db push` | Apply schema to `hypertron_indexer` |
| `npm test` | Jest (`--passWithNoTests`) |
| `npm run probe:events` | Dump live pool events |
| `npm run lint` | ESLint |

---

## Deploy (Render)

[`render.yaml`](render.yaml) is the Blueprint: Node 20, Oregon, health `/health`, current testnet env, and the private Render Valkey URL.

1. Create the web service from the Blueprint.
2. Set dashboard-only values:
   - `DATABASE_URL` — Atlas URI for `hypertron_indexer`
   - `CORS_ORIGINS` — comma-separated frontend origins, no trailing slashes
3. Do **not** set a fixed production `PORT`. Use Render's injected port.
4. Keep the Valkey instance and web service in the **same region** so the private hostname resolves.

Manual (no Blueprint):

```text
Build Command: npm ci --include=dev && npm run build
Start Command: npm start
Health Check Path: /health
```

---

## Related docs

- [`docs/event-layout.md`](docs/event-layout.md) — Soroban topic layout
- [`deployments/testnet.json`](deployments/testnet.json) — pool / commitment / nullifier IDs
