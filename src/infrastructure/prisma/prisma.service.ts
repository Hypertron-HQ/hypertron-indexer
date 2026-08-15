import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    this.logger.log('Connecting to MongoDB...');
    await this.$connect();
    this.logger.log('MongoDB connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
