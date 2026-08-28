import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DefectsCommandController } from './defects-command.controller';
import { LookupsController } from './lookups.controller';
import { OperationsService } from './operations.service';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [LookupsController, DefectsCommandController],
  providers: [OperationsService],
  exports: [OperationsService],
})
export class OperationsModule {}
