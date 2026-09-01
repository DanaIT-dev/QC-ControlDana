import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../auth/prisma.module';
import { SuperAdminMutationRateLimitGuard } from './super-admin-rate-limit.guard';
import { SuperAdminController } from './super-admin.controller';
import { SuperAdminService } from './super-admin.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SuperAdminController],
  providers: [SuperAdminService, SuperAdminMutationRateLimitGuard],
})
export class SuperAdminModule {}
