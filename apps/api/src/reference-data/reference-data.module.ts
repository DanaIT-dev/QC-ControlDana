import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RedisModule } from '../auth/redis.module.js';
import { ReferenceDataController } from './reference-data.controller.js';
import { ReferenceDataService } from './reference-data.service.js';
import { DirectoryMutateRateLimitGuard } from './directory-mutate-rate-limit.guard.js';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule, RedisModule],
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService, DirectoryMutateRateLimitGuard],
})
export class ReferenceDataModule {}
