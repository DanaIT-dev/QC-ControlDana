import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SystemStatusController } from './system-status.controller';

@Module({
  imports: [AuthModule, NotificationsModule],
  controllers: [HealthController, SystemStatusController],
  providers: [HealthService],
})
export class HealthModule {}
