import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { OperationsService } from './operations.service';

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
  auditLog() {
    return { items: [], totalCount: 0, nextCursor: null };
  }
}
