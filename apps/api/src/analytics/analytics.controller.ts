import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { AnalyticsService } from './analytics.service.js';
import { FinancialImpactService } from './financial.service.js';

@Controller('analytics')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('VIEW_QUALITY_ANALYTICS')
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.overview(user, query);
  }

  @Get('costs')
  costs(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.costs(user, query);
  }

  @Get('liability')
  liability(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.liability(user, query);
  }

  @Get('process')
  process(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.process(user, query);
  }

  @Get('patterns')
  patterns(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.patterns(user, query);
  }

  @Get('patterns/:insightId/defects')
  supportDefects(
    @CurrentUser() user: AuthenticatedUser,
    @Param('insightId') insightId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.analytics.supportDefects(user, insightId, query);
  }

  @Get('data-quality')
  dataQuality(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.dataQuality(user, query);
  }

  @Get('drilldown')
  drilldown(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.drilldown(user, query);
  }

  @Get('filters')
  filters(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.analytics.filters(user, query);
  }

  @Post('insights/:insightId/review')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('REVIEW_ANALYTICS_INSIGHTS')
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('insightId') insightId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.analytics.review(user, insightId, body, request);
  }
}

@Controller('defects')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class FinancialImpactController {
  constructor(
    @Inject(FinancialImpactService) private readonly financials: FinancialImpactService,
  ) {}

  @Get(':defectItemId/financials')
  @RequireCapability('VIEW_FINANCIAL_ANALYTICS')
  list(@CurrentUser() user: AuthenticatedUser, @Param('defectItemId') defectItemId: string) {
    return this.financials.list(user, defectItemId);
  }

  @Post(':defectItemId/financials')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_DEFECT_FINANCIALS')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.financials.create(user, defectItemId, body, request);
  }

  @Post(':defectItemId/financials/:impactId/confirm')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_DEFECT_FINANCIALS')
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Param('impactId') impactId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.financials.confirm(user, defectItemId, impactId, request);
  }

  @Post(':defectItemId/financials/:impactId/void')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_DEFECT_FINANCIALS')
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Param('impactId') impactId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.financials.void(user, defectItemId, impactId, request);
  }
}
