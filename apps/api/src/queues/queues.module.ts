import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { resolveAttachmentQueueName, resolveNotificationQueueName } from '@sgr-registry/domain';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return {
          connection: {
            url: config.REDIS_URL,
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: resolveNotificationQueueName() }),
    BullModule.registerQueue({ name: resolveAttachmentQueueName() }),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
