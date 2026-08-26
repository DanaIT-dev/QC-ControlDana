import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { ReadyResponse } from '@sgr-registry/contracts';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { HealthService } from './health.service';

@Controller('system-status')
@UseGuards(AuthenticationGuard, RolesGuard)
@Roles('ADMIN')
export class SystemStatusController {
  constructor(@Inject(HealthService) private readonly healthService: HealthService) {}

  @Get()
  async getStatus(): Promise<ReadyResponse> {
    return this.healthService.getReadiness();
  }
}
