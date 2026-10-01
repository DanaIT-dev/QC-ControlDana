import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { OperationsService } from './operations.service.js';

@Controller()
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class HistoryReadController {
  constructor(@Inject(OperationsService) private readonly operationsService: OperationsService) {}

  @Get('defects/:defectItemId/history')
  @RequireCapability('VIEW_HISTORY', 'VIEW_ASSIGNED_HISTORY')
  defectHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.operationsService.defectHistory(user, defectItemId, query);
  }

  @Get('proposals/:proposalId/history')
  @RequireCapability('VIEW_HISTORY', 'VIEW_ASSIGNED_HISTORY')
  proposalHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('proposalId') proposalId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.operationsService.proposalHistory(user, proposalId, query);
  }

  @Get('audit-log')
  @RequireCapability('VIEW_HISTORY')
  auditLog(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.operationsService.listAuditLog(user, query);
  }
}
