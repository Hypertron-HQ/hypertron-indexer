import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { NetworksConfig } from '@/common/config/networks.config';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { RedisService, ROOT_HISTORY } from '@/infrastructure/redis/redis.service';
import { MerkleService } from '@/modules/merkle/merkle.service';

const MAX_COMMITMENT_LOOKUP = 100;

function normalizeLeafHex(value: string): string | null {
  const cleaned = value.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) return null;
  return `0x${cleaned}`;
}

@Injectable()
export class PoolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly merkle: MerkleService,
    private readonly config: ConfigService,
  ) {}

  private assertNetwork(network: string) {
    const nets = this.config.get<NetworksConfig>('networks');
    const found = nets?.networks.find((n) => n.network === network);
    if (!found) {
      throw new NotFoundException(`Unknown network: ${network}`);
    }
    return found;
  }

  async getLeaves(network: string, since = 0) {
    this.assertNetwork(network);
    const healthy = await this.redis.isHealthy(network);
    const leaves = await this.merkle.loadOrderedLeaves(network);
    const start = Math.max(0, Math.floor(since));
    const slice = leaves.slice(start);
    const root =
      leaves.length === 0
        ? null
        : (
            await this.prisma.commitment.findFirst({
              where: { network },
              orderBy: { leafIndex: 'desc' },
              select: { rootAfter: true },
            })
          )?.rootAfter ?? null;

    return {
      leaves: slice,
      size: leaves.length,
      root,
      since: start,
      healthy,
    };
  }

  async getBlobs(network: string, sinceLedger = 0) {
    this.assertNetwork(network);
    const rows = await this.prisma.noteBlob.findMany({
      where: {
        network,
        ledger: { gte: Math.max(0, Math.floor(sinceLedger)) },
      },
      orderBy: { ledger: 'asc' },
      select: { blob: true, leafIndex: true, ledger: true },
    });
    return {
      blobs: rows.map((r) => ({
        blob: r.blob,
        leafIndex: r.leafIndex,
        ledger: r.ledger,
      })),
    };
  }

  /**
   * Lookup commitment rows by leaf hex (0x…). Used by auditor disclosure to
   * attach the on-chain tx hash without re-indexing note blobs.
   */
  async getCommitmentsByLeaves(network: string, leavesRaw: string) {
    this.assertNetwork(network);

    const requested = leavesRaw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (requested.length === 0) {
      throw new BadRequestException('leaves query required (comma-separated 0x hex)');
    }
    if (requested.length > MAX_COMMITMENT_LOOKUP) {
      throw new BadRequestException(
        `At most ${MAX_COMMITMENT_LOOKUP} leaves per request`,
      );
    }

    const normalized: string[] = [];
    for (const leaf of requested) {
      const n = normalizeLeafHex(leaf);
      if (!n) {
        throw new BadRequestException(`Invalid leaf hex: ${leaf.slice(0, 18)}…`);
      }
      normalized.push(n);
    }
    const unique = [...new Set(normalized)];

    const rows = await this.prisma.commitment.findMany({
      where: { network, leaf: { in: unique } },
      select: {
        leaf: true,
        leafIndex: true,
        ledger: true,
        txHash: true,
      },
    });

    const byLeaf = new Map(
      rows.map((r) => [r.leaf.toLowerCase(), r] as const),
    );

    return {
      commitments: unique.map((leaf) => {
        const row = byLeaf.get(leaf.toLowerCase());
        return {
          leaf,
          leafIndex: row?.leafIndex ?? null,
          ledger: row?.ledger ?? null,
          txHash: row?.txHash ?? null,
        };
      }),
    };
  }

  async getNullifiers(network: string) {
    this.assertNetwork(network);
    const rows = await this.prisma.spentNullifier.findMany({
      where: { network },
      select: { nullifier: true },
    });
    return { nullifiers: rows.map((r) => r.nullifier) };
  }

  async getStatus(network: string) {
    const net = this.assertNetwork(network);
    const cursor = await this.prisma.indexerCursor.findUnique({
      where: { id: network },
    });
    const size = await this.prisma.commitment.count({ where: { network } });
    const last = await this.prisma.commitment.findFirst({
      where: { network },
      orderBy: { leafIndex: 'desc' },
      select: { rootAfter: true },
    });
    const healthy = await this.redis.isHealthy(network);
    const recentRoots = await this.redis.getRecentRoots(network);

    return {
      lastLedger: cursor?.lastLedger ?? null,
      size,
      root: last?.rootAfter ?? null,
      healthy,
      depth: this.merkle.getDepth(),
      rootHistory: ROOT_HISTORY,
      recentRootCount: recentRoots.length,
      commitmentContract: net.commitment,
      /** If client root is older than rootHistory inserts, proofs fail with UnknownRoot */
      unknownRootRisk:
        recentRoots.length >= ROOT_HISTORY
          ? 'Client roots older than the oldest retained root will fail UnknownRoot — rebuild from /leaves'
          : null,
    };
  }
}
