import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { QueuesModule } from '../queues/queues.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { SystemStatusController } from './system-status.controller.js';

@Module({
  imports: [AuthModule, QueuesModule],
  controllers: [HealthController, SystemStatusController],
  providers: [HealthService],
})
export class HealthModule {}
