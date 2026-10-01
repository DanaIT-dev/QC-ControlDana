import { Module } from '@nestjs/common';
import { OutboxWriter } from '@sgr-registry/jobs';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { RedisModule } from '../auth/redis.module.js';
import { QueuesModule } from '../queues/queues.module.js';
import { NotificationMutationRateLimitGuard } from './notification-rate-limit.guard.js';
import {
  NotificationSettingsController,
  NotificationsController,
} from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { SlaController } from './sla.controller.js';
import { SlaQueryService } from './sla.service.js';

@Module({
  imports: [PrismaModule, AuthModule, RedisModule, QueuesModule],
  controllers: [NotificationsController, NotificationSettingsController, SlaController],
  providers: [
    OutboxWriter,
    NotificationsService,
    SlaQueryService,
    NotificationMutationRateLimitGuard,
  ],
  exports: [OutboxWriter],
})
export class NotificationsModule {}
