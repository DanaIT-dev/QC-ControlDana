import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { OperationsModule } from '../operations/operations.module.js';
import { ActsController } from './acts.controller.js';
import { RegistryController } from './registry.controller.js';
import { RegistryService } from './registry.service.js';
import { ActChatService } from './act-chat.service.js';
import { ActChatRateLimitGuard } from './act-chat-rate-limit.guard.js';
import { ActStartRateLimitGuard } from './act-start-rate-limit.guard.js';

@Module({
  imports: [PrismaModule, AuthModule, OperationsModule],
  controllers: [RegistryController, ActsController],
  providers: [RegistryService, ActChatService, ActChatRateLimitGuard, ActStartRateLimitGuard],
  exports: [RegistryService],
})
export class RegistryModule {}
