import { Module } from '@nestjs/common';
import { OutboxWriter } from '@sgr-registry/jobs';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { RedisModule } from '../auth/redis.module';
import { QueuesModule } from '../queues/queues.module';
import { NotificationMutationRateLimitGuard } from './notification-rate-limit.guard';
import {
  NotificationSettingsController,
  NotificationsController,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { SlaController } from './sla.controller';
import { SlaQueryService } from './sla.service';

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
