import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { RegistryService } from './registry.service';

@Controller('registry')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('VIEW_ALL_ACTS', 'VIEW_ASSIGNED_DEFECTS')
export class RegistryController {
  constructor(@Inject(RegistryService) private readonly registryService: RegistryService) {}

  @Get('defects')
  defects(@CurrentUser() user: AuthenticatedUser, @Req() request: FastifyRequest) {
    return this.registryService.list(user, (request.query ?? {}) as Record<string, unknown>);
  }

  @Get('filter-options')
  filterOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.registryService.filterOptions(user);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthenticatedUser, @Req() request: FastifyRequest) {
    return this.registryService.summary(user, (request.query ?? {}) as Record<string, unknown>);
  }
}
