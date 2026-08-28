import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QueuesModule } from '../queues/queues.module';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { createS3Client, ObjectStore, resolveAttachmentBucket } from './object-store';

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
