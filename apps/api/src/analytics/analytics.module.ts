import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../auth/prisma.module.js';
import { AnalyticsController, FinancialImpactController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { FinancialImpactService } from './financial.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AnalyticsController, FinancialImpactController],
  providers: [AnalyticsService, FinancialImpactService],
})
export class AnalyticsModule {}
