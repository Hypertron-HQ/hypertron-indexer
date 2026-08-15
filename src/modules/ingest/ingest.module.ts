import { Module } from '@nestjs/common';

import { MerkleModule } from '@/modules/merkle/merkle.module';
import { IngestScheduler } from './ingest.scheduler';
import { IngestService } from './ingest.service';

@Module({
  imports: [MerkleModule],
  providers: [IngestService, IngestScheduler],
  exports: [IngestService],
})
export class IngestModule {}
