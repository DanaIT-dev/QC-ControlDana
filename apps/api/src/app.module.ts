import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './auth/prisma.module';
import { RedisModule } from './auth/redis.module';
import { SafeExceptionFilter } from './common/safe-exception.filter';
import { HealthModule } from './health/health.module';
import { RegistryModule } from './registry/registry.module';
import { UsersModule } from './users/users.module';
import { ReferenceDataModule } from './reference-data/reference-data.module';
import { OperationsModule } from './operations/operations.module';
import { AttachmentsModule } from './attachments/attachments.module';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuthModule,
    HealthModule,
    RegistryModule,
    UsersModule,
    ReferenceDataModule,
    OperationsModule,
    AttachmentsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SafeExceptionFilter,
    },
  ],
})
export class AppModule {}
