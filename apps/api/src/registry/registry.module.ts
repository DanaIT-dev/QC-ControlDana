import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { OperationsModule } from '../operations/operations.module';
import { ActsController } from './acts.controller';
import { RegistryController } from './registry.controller';
import { RegistryService } from './registry.service';
import { ActChatService } from './act-chat.service';
import { ActChatRateLimitGuard } from './act-chat-rate-limit.guard';

@Module({
  imports: [PrismaModule, AuthModule, OperationsModule],
  controllers: [RegistryController, ActsController],
  providers: [RegistryService, ActChatService, ActChatRateLimitGuard],
  exports: [RegistryService],
})
export class RegistryModule {}
