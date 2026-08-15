# Soroban event topic layout (indexer)

Probed against testnet via `npm run probe:events`.

## Expected layout (CAP-46 `#[contractevent]`)

After `scValToNative`:

| Position | Meaning |
|----------|---------|
| `topic[0]` | Event name as snake_case string Symbol, e.g. `"commit_inserted"` |
| `topic[1+]` | Fields marked `#[topic]` in Rust (e.g. `CommitInserted.index`, `Deposited.index`) |
| `value` | Map/object of remaining fields (`leaf`, `root`, `nullifier`, `note_1`, …) |

## Events we ingest

| Name | Topics | Value fields | Indexer action |
|------|--------|--------------|----------------|
| `commit_inserted` | `[name, index]` | `leaf`, `root` | Ordered leaf feed |
| `private_transfer` | `[name]` | `nullifier`, `out_index_1/2`, `note_1/2` | Blobs + nullifier |
| `deposited` | `[name, index]` | `amount` | Logged / ignored for store v1 |
| `unshielded` | `[name]` | `nullifier`, `amount`, `change_index` | Nullifier |
| `nullifier_spent` | `[name]` | `nullifier` | Nullifier |

## Probe result (14 Aug 2026)

`npm run probe:events` confirmed live `commit_inserted` and `deposited`
events. Soroban converts Rust event struct names to snake_case symbols.

## Note on empty history

The July 2026 testnet deploy is past the ~7-day RPC event window. If the probe
returns zero events, redeploy the pool and set `INDEXER_START_LEDGER` to the
deploy ledger so the indexer starts from ledger one of the new tree.
