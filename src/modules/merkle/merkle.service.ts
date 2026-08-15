/**
 * Merkle root recompute (DEPTH=20) + contract verification.
 *
 * Prefers prover-wasm `merkle_root` when MERKLE_WASM_DIR is set.
 * Always cross-checks commitment.root() / size() on-chain.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRequire } from 'module';

import type { NetworksConfig } from '@/common/config/networks.config';
import { RedisService, ROOT_HISTORY } from '@/infrastructure/redis/redis.service';
import { SorobanService } from '@/infrastructure/soroban/soroban.service';
import { PrismaService } from '@/infrastructure/prisma/prisma.service';
import { DEPTH } from './merkle.constants';

export interface VerifyResult {
  ok: boolean;
  leafCount: number;
  recomputedRoot: string | null;
  contractRoot: string | null;
  contractSize: number | null;
  error?: string;
}

@Injectable()
export class MerkleService {
  private readonly logger = new Logger(MerkleService.name);
  private wasmMerkleRoot:
    | ((leavesJson: string) => string)
    | null
    | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly soroban: SorobanService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async loadOrderedLeaves(network: string): Promise<string[]> {
    const cached = await this.redis.getLeaves(network);
    if (cached) return cached;

    const rows = await this.prisma.commitment.findMany({
      where: { network },
      orderBy: { leafIndex: 'asc' },
      select: { leaf: true, leafIndex: true },
    });

    // Contiguity: indices must be 0..n-1
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].leafIndex !== i) {
        throw new Error(
          `Non-contiguous leaves at index ${i}: found ${rows[i].leafIndex}`,
        );
      }
    }

    const leaves = rows.map((r) => r.leaf);
    await this.redis.setLeaves(network, leaves);
    return leaves;
  }

  async recomputeRoot(leaves: string[]): Promise<string> {
    if (leaves.length === 0) {
      // Empty-tree root: Poseidon ladder of zeros — get from wasm or contract
      const fn = this.getWasmMerkleRoot();
      if (fn) return normalize0x(fn(JSON.stringify([])));
      throw new Error('Empty tree root requires merkle_root wasm or contract read');
    }

    const fn = this.getWasmMerkleRoot();
    if (fn) {
      return normalize0x(fn(JSON.stringify(leaves)));
    }

    // Fallback: use last stored rootAfter (event-sourced). Full Poseidon
    // recompute requires MERKLE_WASM_DIR pointing at prover-wasm pkg.
    throw new Error(
      'MERKLE_WASM_DIR not configured — cannot recompute root from leaves',
    );
  }

  async verifyNetwork(network: string, commitmentId: string): Promise<VerifyResult> {
    let leaves: string[];
    try {
      leaves = await this.loadOrderedLeaves(network);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.redis.setHealthy(network, false);
      return {
        ok: false,
        leafCount: 0,
        recomputedRoot: null,
        contractRoot: null,
        contractSize: null,
        error: msg,
      };
    }

    let contractRoot: string;
    let contractSize: number;
    try {
      contractRoot = normalize0x(
        await this.soroban.readCommitmentRoot(commitmentId),
      );
      contractSize = await this.soroban.readCommitmentSize(commitmentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        leafCount: leaves.length,
        recomputedRoot: null,
        contractRoot: null,
        contractSize: null,
        error: `contract read failed: ${msg}`,
      };
    }

    if (contractSize !== leaves.length) {
      await this.redis.setHealthy(network, false);
      return {
        ok: false,
        leafCount: leaves.length,
        recomputedRoot: null,
        contractRoot,
        contractSize,
        error: `size mismatch: db=${leaves.length} chain=${contractSize}`,
      };
    }

    let recomputedRoot: string | null = null;
    const wasm = this.getWasmMerkleRoot();
    if (wasm) {
      try {
        recomputedRoot = normalize0x(wasm(JSON.stringify(leaves)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.redis.setHealthy(network, false);
        return {
          ok: false,
          leafCount: leaves.length,
          recomputedRoot: null,
          contractRoot,
          contractSize,
          error: `wasm merkle_root failed: ${msg}`,
        };
      }
    } else {
      // Without wasm: require last event rootAfter == contract root
      const last = await this.prisma.commitment.findFirst({
        where: { network },
        orderBy: { leafIndex: 'desc' },
        select: { rootAfter: true },
      });
      recomputedRoot = last
        ? normalize0x(last.rootAfter)
        : contractRoot; // empty tree
      this.logger.warn(
        'MERKLE_WASM_DIR unset — verifying via last rootAfter + contract root/size only',
      );
    }

    if (normalize0x(recomputedRoot) !== contractRoot) {
      await this.redis.setHealthy(network, false);
      return {
        ok: false,
        leafCount: leaves.length,
        recomputedRoot,
        contractRoot,
        contractSize,
        error: `root mismatch: local=${recomputedRoot} chain=${contractRoot}`,
      };
    }

    await this.redis.pushRoot(network, contractRoot);
    await this.redis.setHealthy(network, true);
    return {
      ok: true,
      leafCount: leaves.length,
      recomputedRoot,
      contractRoot,
      contractSize,
    };
  }

  /**
   * How many inserts ago `clientRoot` appears in the last ROOT_HISTORY roots.
   * null if unknown / not in history (client should rebuild).
   */
  async rootAge(network: string, clientRoot: string): Promise<number | null> {
    const roots = await this.redis.getRecentRoots(network);
    const needle = normalize0x(clientRoot);
    const idx = roots.findIndex((r) => normalize0x(r) === needle);
    if (idx < 0) return null;
    return idx; // 0 = current
  }

  getRootHistoryLimit(): number {
    return ROOT_HISTORY;
  }

  getDepth(): number {
    return DEPTH;
  }

  private getWasmMerkleRoot(): ((leavesJson: string) => string) | null {
    if (this.wasmMerkleRoot !== undefined) {
      return this.wasmMerkleRoot;
    }
    const nets = this.config.get<NetworksConfig>('networks');
    const dir = nets?.merkleWasmDir?.trim();
    if (!dir) {
      this.wasmMerkleRoot = null;
      return null;
    }
    // Prefer node target from prover-wasm/pkg/node (or pkg/ if flat)
    const candidates = [
      join(dir, 'node', 'hypertron_prover.js'),
      join(dir, 'hypertron_prover.js'),
      join(dir, 'hypertron_prover_bg.js'),
    ];
    const entry = candidates.find((p) => existsSync(p)) ?? null;
    if (!entry) {
      this.logger.warn({ dir }, 'MERKLE_WASM_DIR has no hypertron_prover.js');
      this.wasmMerkleRoot = null;
      return null;
    }
    try {
      const require = createRequire(__filename);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(entry) as {
        merkle_root?: (s: string) => string;
        merkleRoot?: (s: string) => string;
      };
      const fn = mod.merkle_root ?? mod.merkleRoot;
      if (!fn) {
        this.logger.warn('WASM loaded but merkle_root export missing');
        this.wasmMerkleRoot = null;
        return null;
      }
      this.wasmMerkleRoot = fn.bind(mod);
      return this.wasmMerkleRoot;
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Failed to load merkle wasm',
      );
      this.wasmMerkleRoot = null;
      return null;
    }
  }
}

function normalize0x(s: string): string {
  const t = s.trim().toLowerCase();
  return t.startsWith('0x') ? t : `0x${t}`;
}
