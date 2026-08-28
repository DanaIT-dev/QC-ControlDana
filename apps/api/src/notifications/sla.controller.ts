import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { SlaQueryService } from './sla.service';

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
