import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { SuperAdminMutationRateLimitGuard } from './super-admin-rate-limit.guard.js';
import { SuperAdminController } from './super-admin.controller.js';
import { SuperAdminService } from './super-admin.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService, SuperAdminMutationRateLimitGuard],
})
export class SuperAdminModule {}
