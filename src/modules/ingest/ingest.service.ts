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
            err: err instanceof Error ? err.message : String(err),
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
    const cursor = await this.prisma.indexerCursor.findUnique({
      where: { id: network.network },
    });
    const lastLedger = cursor?.lastLedger ?? startLedgerFallback - 1;
    // First run: start at INDEXER_START_LEDGER; thereafter lastLedger+1
    const from = cursor ? cursor.lastLedger + 1 : startLedgerFallback;

    const { events, latestLedger } = await this.soroban.getEvents({
      startLedger: from,
      contractIds: [network.commitment, network.pool, network.nullifier],
      limit: 200,
    });

    if (events.length === 0) {
      if (latestLedger > lastLedger) {
        await this.setCursor(network.network, latestLedger);
      }
      return;
    }

    let touchedCommitments = false;
    const expectedNext = await this.prisma.commitment.count({
      where: { network: network.network },
    });
    let nextIndex = expectedNext;

    for (const ev of events) {
      const parsed = parsePoolEvent(ev.name, ev.topics, ev.value);
      for (const item of parsed) {
        if (item.kind === 'CommitInserted') {
          if (item.index !== nextIndex) {
            this.logger.error(
              {
                network: network.network,
                expected: nextIndex,
                got: item.index,
              },
              'CommitInserted contiguity break — pausing ingest',
            );
            await this.redis.setHealthy(network.network, false);
            this.ingestEnabled.set(network.network, false);
            return;
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
        // Deposited / Unshielded: nullifier already handled; amounts not stored in v1
      }
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
    }

    await this.setCursor(network.network, latestLedger);
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
