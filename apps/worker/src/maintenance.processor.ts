import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

@Processor('sgr-maintenance')
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  async process(job: Job<{ reason?: string }>): Promise<{ ok: true }> {
    this.logger.log(`Processed maintenance job ${job.id ?? 'unknown'}`);
    return { ok: true };
  }
}
