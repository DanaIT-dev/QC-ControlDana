import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { QueuesModule } from '../queues/queues.module.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { createS3Client, ObjectStore, resolveAttachmentBucket } from './object-store.js';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule, QueuesModule],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    {
      provide: ObjectStore,
      useFactory: async () => {
        const config = loadConfig();
        const client = createS3Client(config);
        const store = new ObjectStore(client, resolveAttachmentBucket(config));
        await store.ensureBucket();
        return store;
      },
    },
  ],
  exports: [ObjectStore, AttachmentsService],
})
export class AttachmentsModule {}
