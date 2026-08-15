import { Controller, Get, Param, Query } from '@nestjs/common';

import { PoolService } from './pool.service';

@Controller('v1/pool')
export class PoolController {
  constructor(private readonly pool: PoolService) {}

  @Get(':network/leaves')
  getLeaves(
    @Param('network') network: string,
    @Query('since') since?: string,
  ) {
    const sinceIdx = since !== undefined ? Number(since) : 0;
    return this.pool.getLeaves(
      network,
      Number.isFinite(sinceIdx) ? sinceIdx : 0,
    );
  }

  @Get(':network/blobs')
  getBlobs(
    @Param('network') network: string,
    @Query('since') since?: string,
  ) {
    const sinceLedger = since !== undefined ? Number(since) : 0;
    return this.pool.getBlobs(
      network,
      Number.isFinite(sinceLedger) ? sinceLedger : 0,
    );
  }

  @Get(':network/commitments')
  getCommitments(
    @Param('network') network: string,
    @Query('leaves') leaves?: string,
  ) {
    return this.pool.getCommitmentsByLeaves(network, leaves ?? '');
  }

  @Get(':network/nullifiers')
  getNullifiers(@Param('network') network: string) {
    return this.pool.getNullifiers(network);
  }

  @Get(':network/status')
  getStatus(@Param('network') network: string) {
    return this.pool.getStatus(network);
  }
}
