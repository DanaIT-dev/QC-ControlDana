import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { SlaQueryService } from './sla.service.js';

@Controller('sla')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('VIEW_DEADLINE_CONTROL')
export class SlaController {
  constructor(@Inject(SlaQueryService) private readonly slaQueryService: SlaQueryService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.slaQueryService.summary(user);
  }

  @Get('items')
  items(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.slaQueryService.list(user, query);
  }
}
