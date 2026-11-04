import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { ObjectsController } from './objects.controller.js';
import { ObjectsService } from './objects.service.js';
import { ObjectCreateRateLimitGuard } from './object-create-rate-limit.guard.js';

@Module({
  imports: [PrismaModule, AuthModule, NotificationsModule],
  controllers: [ObjectsController],
  providers: [ObjectsService, ObjectCreateRateLimitGuard],
})
export class ObjectsModule {}
