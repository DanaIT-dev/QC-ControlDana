import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { MaintenanceProcessor } from './maintenance.processor';

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return { connection: { url: config.REDIS_URL } };
      },
    }),
    BullModule.registerQueue({
      name: 'sgr-maintenance',
    }),
  ],
  providers: [MaintenanceProcessor],
})
export class WorkerModule {}
