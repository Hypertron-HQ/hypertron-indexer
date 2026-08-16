import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@/common/config/app.config';
import type {
  NetworkContracts,
  NetworksConfig,
} from '@/common/config/networks.config';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { RedisService } from '@/infrastructure/redis/redis.service';
import { SorobanService } from '@/infrastructure/soroban/soroban.service';
import { MerkleService } from '@/modules/merkle/merkle.service';
import { parsePoolEvent } from './event-parser';

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  /** When false, stop advancing cursor for that network */
  private readonly ingestEnabled = new Map<string, boolean>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly redis: RedisService,
    private readonly merkle: MerkleService,
    private readonly config: ConfigService,
  ) {}

  async tickAll(): Promise<void> {
    const app = this.config.get<AppConfig>('app');
    if (app?.disableIngest) return;

    const nets = this.config.get<NetworksConfig>('networks');
    if (!nets) return;

    for (const network of nets.networks) {
      if (!network.enabled) continue;
      if (this.ingestEnabled.get(network.network) === false) {
        continue;
      }
      try {
        await this.tickNetwork(network, nets.startLedger);
      } catch (err) {
        this.logger.error(
          {
            network: network.network,
            err:
              err instanceof Error
                ? err.message
                : JSON.stringify(err, (_k, v) =>
                    typeof v === 'bigint' ? v.toString() : v,
                  ),
          },
          'Ingest tick failed',
        );
      }
    }
  }

  async tickNetwork(
    network: NetworkContracts,
    startLedgerFallback: number,
  ): Promise<void> {
    const latest = await this.soroban.getLatestLedger();
    // Public testnet RPC drops history older than ~1 day. Starting further
    // back returns an empty page (and we used to jump the cursor to the tip).
    const retentionFloor = Math.max(1, latest - 16_000);

    const cursor = await this.prisma.indexerCursor.findUnique({
      where: { id: network.network },
    });
    const agg = await this.prisma.commitment.aggregate({
      where: { network: network.network },
      _max: { leafIndex: true },
    });
    let nextIndex = (agg._max.leafIndex ?? -1) + 1;

    let from = cursor ? cursor.lastLedger + 1 : startLedgerFallback;
    if (!cursor || nextIndex === 0) {
      from = Math.max(startLedgerFallback, retentionFloor);
    } else if (from < retentionFloor) {
      from = retentionFloor;
    }

    const { events, latestLedger } = await this.soroban.getEventsSince(from, [
      network.commitment,
      network.pool,
      network.nullifier,
    ]);

    if (events.length === 0) {
      let chainSize = 0;
      try {
        chainSize = await this.soroban.readCommitmentSize(network.commitment);
      } catch {
        chainSize = 0;
      }
      if (chainSize > nextIndex) {
        this.logger.warn(
          { network: network.network, from, chainSize, nextIndex },
          'RPC returned no events but the tree has leaves — not advancing cursor',
        );
        return;
      }
      if (latestLedger > (cursor?.lastLedger ?? from - 1)) {
        await this.setCursor(network.network, latestLedger);
      }
      return;
    }

    events.sort((a, b) => a.ledger - b.ledger || a.txHash.localeCompare(b.txHash));

    let touchedCommitments = false;
    let pausedForGap = false;

    for (const ev of events) {
      const parsed = parsePoolEvent(ev.name, ev.topics, ev.value);
      for (const item of parsed) {
        if (item.kind === 'CommitInserted') {
          if (item.index < nextIndex) {
            continue;
          }
          if (item.index !== nextIndex) {
            this.logger.warn(
              {
                network: network.network,
                expected: nextIndex,
                got: item.index,
                ledger: ev.ledger,
              },
              'CommitInserted gap — waiting for earlier leaves, not pausing',
            );
            pausedForGap = true;
            break;
          }
          await this.prisma.commitment.upsert({
            where: {
              network_leafIndex: {
                network: network.network,
                leafIndex: item.index,
              },
            },
            create: {
              network: network.network,
              leafIndex: item.index,
              leaf: item.leaf,
              rootAfter: item.root,
              ledger: ev.ledger,
              txHash: ev.txHash,
            },
            update: {
              leaf: item.leaf,
              rootAfter: item.root,
              ledger: ev.ledger,
              txHash: ev.txHash,
            },
          });
          nextIndex += 1;
          touchedCommitments = true;
        } else if (item.kind === 'NoteBlob') {
          await this.prisma.noteBlob.create({
            data: {
              network: network.network,
              leafIndex: item.leafIndex,
              blob: item.blob,
              ledger: ev.ledger,
            },
          });
        } else if (item.kind === 'NullifierSpent') {
          await this.prisma.spentNullifier.upsert({
            where: {
              network_nullifier: {
                network: network.network,
                nullifier: item.nullifier,
              },
            },
            create: {
              network: network.network,
              nullifier: item.nullifier,
              ledger: ev.ledger,
            },
            update: { ledger: ev.ledger },
          });
        }
      }
      if (pausedForGap) break;
    }

    if (touchedCommitments) {
      await this.redis.invalidateLeaves(network.network);
      const verify = await this.merkle.verifyNetwork(
        network.network,
        network.commitment,
      );
      if (!verify.ok) {
        this.logger.error(
          { network: network.network, error: verify.error },
          'Root verification failed — pausing ingest',
        );
        this.ingestEnabled.set(network.network, false);
        return;
      }
      await this.redis.setHealthy(network.network, true);
    }

    if (pausedForGap) {
      return;
    }

    const maxEventLedger = events.reduce((m, e) => Math.max(m, e.ledger), from);
    await this.setCursor(network.network, Math.max(maxEventLedger, latestLedger));
    this.logger.debug(
      {
        network: network.network,
        events: events.length,
        latestLedger,
        leaves: nextIndex,
      },
      'Ingest batch ok',
    );
  }

  private async setCursor(network: string, lastLedger: number): Promise<void> {
    await this.prisma.indexerCursor.upsert({
      where: { id: network },
      create: { id: network, lastLedger },
      update: { lastLedger },
    });
  }
}
