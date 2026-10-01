import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { PrismaModule } from './auth/prisma.module.js';
import { RedisModule } from './auth/redis.module.js';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { SuperAdminReadOnlyInterceptor } from './common/super-admin-read-only.interceptor.js';
import { HealthModule } from './health/health.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { UsersModule } from './users/users.module.js';
import { SuperAdminModule } from './super-admin/super-admin.module.js';
import { ReferenceDataModule } from './reference-data/reference-data.module.js';
import { OperationsModule } from './operations/operations.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ObjectsModule } from './objects/objects.module.js';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    AuthModule,
    HealthModule,
    RegistryModule,
    UsersModule,
    SuperAdminModule,
    ReferenceDataModule,
    OperationsModule,
    AttachmentsModule,
    NotificationsModule,
    ObjectsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: SafeExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SuperAdminReadOnlyInterceptor,
    },
  ],
})
export class AppModule {}
