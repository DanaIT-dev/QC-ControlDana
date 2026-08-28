import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ATTACHMENT_QUEUE } from './attachment.constants';
import { AttachmentScanProcessor } from './attachment-scan.processor';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { createS3Client, ObjectStore, resolveAttachmentBucket } from './object-store';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    NotificationsModule,
    BullModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return { connection: { url: config.REDIS_URL } };
      },
    }),
    BullModule.registerQueue({ name: ATTACHMENT_QUEUE }),
  ],
  controllers: [AttachmentsController],
  providers: [
    AttachmentsService,
    AttachmentScanProcessor,
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
