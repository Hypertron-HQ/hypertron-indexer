import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { configValidationSchema } from './common/config/config.validation';
import appConfig from './common/config/app.config';
import databaseConfig from './common/config/database.config';
import redisConfig from './common/config/redis.config';
import networksConfig from './common/config/networks.config';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { SorobanModule } from './infrastructure/soroban/soroban.module';
import { HealthModule } from './health/health.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { MerkleModule } from './modules/merkle/merkle.module';
import { PoolModule } from './modules/pool/pool.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, networksConfig],
      validationSchema: configValidationSchema,
      validationOptions: { abortEarly: true },
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
      },
    }),
    PrismaModule,
    RedisModule,
    SorobanModule,
    MerkleModule,
    IngestModule,
    PoolModule,
    HealthModule,
  ],
})
export class AppModule {}
