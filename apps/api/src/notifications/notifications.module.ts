import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { RedisModule } from '../auth/redis.module';
import { NotificationDispatcher, NotificationProcessor } from './dispatcher';
import { NotificationMutationRateLimitGuard } from './notification-rate-limit.guard';
import {
  NotificationSettingsController,
  NotificationsController,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NOTIFICATION_QUEUE, OutboxWriter } from './outbox.writer';
import { SlaController } from './sla.controller';
import { SlaQueryService } from './sla.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    RedisModule,
    BullModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return { connection: { url: config.REDIS_URL } };
      },
    }),
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  controllers: [NotificationsController, NotificationSettingsController, SlaController],
  providers: [
    OutboxWriter,
    NotificationDispatcher,
    NotificationProcessor,
    NotificationsService,
    SlaQueryService,
    NotificationMutationRateLimitGuard,
  ],
  exports: [OutboxWriter, NotificationDispatcher],
})
export class NotificationsModule {}
