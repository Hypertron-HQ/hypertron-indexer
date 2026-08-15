/**
 * One-shot: probe Soroban getEvents topic layout for pool contracts.
 *
 *   cd hypertron-indexer && npm run probe:events
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { rpc, scValToNative } from '@stellar/stellar-sdk';

loadEnv({ path: resolve(__dirname, '../.env') });

async function main() {
  const deploymentsPath =
    process.env.DEPLOYMENTS_PATH ??
    resolve(__dirname, '../../hypertron-contracts/deployments/testnet.json');
  const dep = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as {
    contracts: { pool: string; commitment: string; nullifier: string };
  };
  const rpcUrl =
    process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
  const server = new rpc.Server(rpcUrl, { allowHttp: true });
  const latest = await server.getLatestLedger();
  const lookback = Number(process.env.PROBE_LOOKBACK ?? '2000');
  const startLedger = Math.max(1, latest.sequence - lookback);

  console.log({ rpcUrl, startLedger, latest: latest.sequence, contracts: dep.contracts });

  const res = await server.getEvents({
    startLedger,
    filters: [
      {
        type: 'contract',
        contractIds: [
          dep.contracts.commitment,
          dep.contracts.pool,
          dep.contracts.nullifier,
        ],
      },
    ],
    limit: 50,
  });

  console.log(`events=${res.events?.length ?? 0} latestLedger=${res.latestLedger}`);

  for (const ev of res.events ?? []) {
    const topics = (ev.topic ?? []).map((t) => {
      try {
        return scValToNative(t);
      } catch (e) {
        return String(e);
      }
    });
    let value: unknown;
    try {
      value = ev.value ? scValToNative(ev.value) : null;
    } catch (e) {
      value = String(e);
    }
    console.log('---');
    console.log(
      JSON.stringify(
        {
          contractId: ev.contractId,
          ledger: ev.ledger,
          txHash: ev.txHash,
          topics,
          value,
        },
        (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    );
  }

  if (!res.events?.length) {
    console.log(
      'No events in lookback window (pool may need redeploy). Topic layout assumed: topic[0]=event name Symbol.',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
