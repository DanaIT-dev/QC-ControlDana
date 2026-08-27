import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { AttachmentScanProcessor } from './attachment-scan.processor';
import { MaintenanceProcessor } from './maintenance.processor';

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
  ],
  providers: [MaintenanceProcessor, AttachmentScanProcessor],
})
export class WorkerModule {}
