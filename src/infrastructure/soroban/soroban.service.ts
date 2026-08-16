/**
 * Soroban RPC wrapper: getEvents + commitment root()/size() reads.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  Account,
  xdr,
} from '@stellar/stellar-sdk';

import type { NetworksConfig } from '@/common/config/networks.config';

export interface RawPoolEvent {
  name: string;
  topics: unknown[];
  value: unknown;
  ledger: number;
  txHash: string;
  contractId: string;
}

@Injectable()
export class SorobanService {
  private readonly logger = new Logger(SorobanService.name);
  private server: rpc.Server | null = null;

  constructor(private readonly config: ConfigService) {}

  getServer(): rpc.Server {
    if (!this.server) {
      const nets = this.config.get<NetworksConfig>('networks')!;
      this.server = new rpc.Server(nets.rpcUrl, { allowHttp: true });
    }
    return this.server;
  }

  async getLatestLedger(): Promise<number> {
    const info = await this.getServer().getLatestLedger();
    return info.sequence;
  }

  async getEvents(input: {
    startLedger: number;
    contractIds: string[];
    limit?: number;
    cursor?: string;
  }): Promise<{ events: RawPoolEvent[]; latestLedger: number; cursor?: string }> {
    const server = this.getServer();
    const filters = [
      {
        type: 'contract' as const,
        contractIds: input.contractIds,
      },
    ];
    const res = input.cursor
      ? await server.getEvents({
          cursor: input.cursor,
          filters,
          limit: input.limit ?? 200,
        })
      : await server.getEvents({
          startLedger: input.startLedger,
          filters,
          limit: input.limit ?? 200,
        });

    const events = this.decodeEvents(res.events ?? []);
    return {
      events,
      latestLedger: res.latestLedger ?? input.startLedger,
      cursor: res.cursor,
    };
  }

  /**
   * Walk getEvents pages so a single ingest tick does not skip early
   * CommitInserted rows when the window has more than `limit` events.
   */
  async getEventsSince(
    startLedger: number,
    contractIds: string[],
  ): Promise<{ events: RawPoolEvent[]; latestLedger: number }> {
    const all: RawPoolEvent[] = [];
    let cursor: string | undefined;
    let latestLedger = startLedger;
    let lastCursor: string | undefined;

    for (let page = 0; page < 25; page++) {
      const res = await this.getEvents({
        startLedger,
        contractIds,
        limit: 200,
        cursor,
      });
      latestLedger = res.latestLedger;
      all.push(...res.events);
      if (!res.events.length || !res.cursor || res.cursor === lastCursor) {
        break;
      }
      if (res.events.length < 200) break;
      lastCursor = res.cursor;
      cursor = res.cursor;
    }

    return { events: all, latestLedger };
  }

  private decodeEvents(
    raw: NonNullable<rpc.Api.GetEventsResponse['events']>,
  ): RawPoolEvent[] {
    const events: RawPoolEvent[] = [];
    for (const ev of raw) {
      try {
        const topicsNative = (ev.topic ?? []).map((t) => {
          try {
            return scValToNative(t);
          } catch {
            return t;
          }
        });
        let valueNative: unknown = null;
        try {
          valueNative = ev.value ? scValToNative(ev.value) : null;
        } catch {
          valueNative = null;
        }

        const name = extractEventName(topicsNative, valueNative);
        events.push({
          name,
          topics: topicsNative,
          value: valueNative,
          ledger: ev.ledger,
          txHash: ev.txHash ?? '',
          contractId:
            typeof ev.contractId === 'string'
              ? ev.contractId
              : String(ev.contractId ?? ''),
        });
      } catch (err) {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Failed to decode event',
        );
      }
    }
    return events;
  }

  /** Read commitment.root() via simulateTransaction. */
  async readCommitmentRoot(commitmentId: string): Promise<string> {
    const bytes = await this.simulateNoAuth(commitmentId, 'root', []);
    return bytesTo0x(bytes);
  }

  /** Read commitment.size() via simulateTransaction. */
  async readCommitmentSize(commitmentId: string): Promise<number> {
    const raw = await this.simulateNoAuth(commitmentId, 'size', []);
    if (typeof raw === 'number' || typeof raw === 'bigint') {
      return Number(raw);
    }
    return Number(raw);
  }

  private async simulateNoAuth(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<unknown> {
    const server = this.getServer();
    const nets = this.config.get<NetworksConfig>('networks')!;
    const network = nets.networks[0];
    const passphrase =
      network?.networkPassphrase ?? 'Test SDF Network ; September 2015';

    // Source account is unused for simulation auth-free reads
    const account = new Account(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      '0',
    );
    const contract = new Contract(contractId);
    const op = contract.call(method, ...args);
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: passphrase,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulated)) {
      throw new Error(`simulate ${method} failed: ${simulated.error}`);
    }
    if (!rpc.Api.isSimulationSuccess(simulated)) {
      throw new Error(`simulate ${method} did not succeed`);
    }

    const retval = simulated.result?.retval;
    if (!retval) {
      throw new Error(`simulate ${method}: empty retval`);
    }
    return scValToNative(retval);
  }
}

/**
 * Soroban contract events put the snake_case event name as topic[0] (Symbol).
 * #[topic] fields follow. Fall back to value.name if needed.
 */
export function extractEventName(
  topics: unknown[],
  value: unknown,
): string {
  if (topics.length > 0) {
    const t0 = topics[0];
    if (typeof t0 === 'string') return t0;
    if (t0 && typeof t0 === 'object' && 'sym' in (t0 as object)) {
      return String((t0 as { sym: string }).sym);
    }
  }
  if (value && typeof value === 'object' && value !== null && 'name' in value) {
    return String((value as { name: unknown }).name);
  }
  return 'Unknown';
}

function bytesTo0x(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.startsWith('0x') ? raw : `0x${raw}`;
  }
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    return `0x${Buffer.from(raw).toString('hex')}`;
  }
  if (Array.isArray(raw)) {
    return `0x${Buffer.from(raw as number[]).toString('hex')}`;
  }
  // Map-like from scValToNative for BytesN
  throw new Error(`Unexpected root type: ${typeof raw}`);
}

// silence unused import if nativeToScVal unused
void nativeToScVal;
