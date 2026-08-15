import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const LEAVES_KEY = (network: string) => `pool:${network}:leaves`;
const ROOTS_KEY = (network: string) => `pool:${network}:roots`;
const HEALTH_KEY = (network: string) => `pool:${network}:healthy`;

/** Root history retained for UnknownRoot detection (matches contract). */
export const ROOT_HISTORY = 32;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<{ url: string }>('redis')?.url ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    this.client.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'Redis error');
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit();
  }

  async getLeaves(network: string): Promise<string[] | null> {
    const raw = await this.client.get(LEAVES_KEY(network));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return null;
    }
  }

  async setLeaves(network: string, leaves: string[]): Promise<void> {
    await this.client.set(LEAVES_KEY(network), JSON.stringify(leaves));
  }

  async invalidateLeaves(network: string): Promise<void> {
    await this.client.del(LEAVES_KEY(network));
  }

  async pushRoot(network: string, root: string): Promise<void> {
    const key = ROOTS_KEY(network);
    await this.client.lpush(key, root);
    await this.client.ltrim(key, 0, ROOT_HISTORY - 1);
  }

  async getRecentRoots(network: string): Promise<string[]> {
    return this.client.lrange(ROOTS_KEY(network), 0, ROOT_HISTORY - 1);
  }

  async setHealthy(network: string, healthy: boolean): Promise<void> {
    await this.client.set(HEALTH_KEY(network), healthy ? '1' : '0');
  }

  async isHealthy(network: string): Promise<boolean> {
    const v = await this.client.get(HEALTH_KEY(network));
    // Default healthy until first failed verification
    if (v === null) return true;
    return v === '1';
  }
}
