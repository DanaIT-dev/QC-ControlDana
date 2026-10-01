import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { OperationsService } from './operations.service.js';

@Controller('operations')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class LookupsController {
  constructor(@Inject(OperationsService) private readonly operationsService: OperationsService) {}

  @Get('lookups')
  @RequireCapability(
    'CREATE_ACT',
    'ADD_DEFECT',
    'EDIT_ASSIGNMENTS',
    'EDIT_ACT_HEADER',
    'MANAGE_PROPOSALS',
    'MANAGE_REFERENCE_DATA',
    'VIEW_ALL_BUSINESS_DATA',
    'VIEW_REFERENCE_DATA',
    'VIEW_ALL_ACTS',
    'VIEW_ORGANIZATION_ACTS',
    'VIEW_ASSIGNED_DEFECTS',
  )
  lookups(@CurrentUser() user: AuthenticatedUser) {
    return this.operationsService.lookups(user);
  }
}
