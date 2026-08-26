import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './auth/prisma.module';
import { RedisModule } from './auth/redis.module';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { HealthModule } from './health/health.module';

@Module({
  imports: [PrismaModule, RedisModule, AuthModule, HealthModule],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SafeExceptionFilter,
    },
  ],
})
export class AppModule {}
