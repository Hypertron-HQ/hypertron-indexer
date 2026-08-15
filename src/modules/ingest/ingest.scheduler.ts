import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@/common/config/app.config';
import { IngestService } from './ingest.service';

const POLL_MS = 5_000;

@Injectable()
export class IngestScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly ingest: IngestService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const app = this.config.get<AppConfig>('app');
    if (app?.disableIngest) {
      this.logger.log('DISABLE_INGEST=true — ingest idle');
      return;
    }

    this.timer = setInterval(() => void this.tick(), POLL_MS);
    setTimeout(() => void this.tick(), 2_000);
    this.logger.log(`Ingest scheduled every ${POLL_MS}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.ingest.tickAll();
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Ingest scheduler tick failed',
      );
    } finally {
      this.running = false;
    }
  }
}
