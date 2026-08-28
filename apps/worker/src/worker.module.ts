import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { AttachmentScanProcessor } from './attachment-scan.processor';
import { MaintenanceProcessor } from './maintenance.processor';
import { NotificationDispatcher, NotificationProcessor } from './notifications/dispatcher';
import { resolveNotificationQueueName } from '@sgr-registry/domain';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return { connection: { url: config.REDIS_URL } };
      },
    }),
    BullModule.registerQueue({ name: 'sgr-maintenance' }),
    BullModule.registerQueue({ name: 'sgr-attachments' }),
    BullModule.registerQueue({ name: resolveNotificationQueueName() }),
  ],
  providers: [
    MaintenanceProcessor,
    AttachmentScanProcessor,
    NotificationDispatcher,
    NotificationProcessor,
  ],
})
export class WorkerModule {}
