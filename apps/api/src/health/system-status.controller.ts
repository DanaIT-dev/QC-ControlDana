import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { SystemStatusResponse } from '@sgr-registry/contracts';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SkipRlsTransaction } from '../auth/skip-rls-transaction';
import { HealthService } from './health.service';

@Controller('system-status')
@UseGuards(AuthenticationGuard, RolesGuard)
@Roles('ADMIN')
export class SystemStatusController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @SkipRlsTransaction()
  @Get()
  async getStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ): Promise<SystemStatusResponse> {
    return this.healthService.getSystemStatus(user, request);
  }
}
