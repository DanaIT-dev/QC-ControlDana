import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DefectsCommandController } from './defects-command.controller.js';
import { HistoryReadController } from './history-read.controller.js';
import { LookupsController } from './lookups.controller.js';
import { OperationsService } from './operations.service.js';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [LookupsController, DefectsCommandController, HistoryReadController],
  providers: [OperationsService],
  exports: [OperationsService],
})
export class OperationsModule {}
