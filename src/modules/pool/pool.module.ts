import { Module } from '@nestjs/common';

import { MerkleModule } from '@/modules/merkle/merkle.module';
import { PoolController } from './pool.controller';
import { PoolService } from './pool.service';

@Module({
  imports: [MerkleModule],
  controllers: [PoolController],
  providers: [PoolService],
})
export class PoolModule {}
