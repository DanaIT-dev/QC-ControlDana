import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { SystemStatusResponse } from '@sgr-registry/contracts';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { SkipRlsTransaction } from '../auth/skip-rls-transaction.js';
import { HealthService } from './health.service.js';

@Controller('system-status')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('VIEW_SYSTEM_STATUS')
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

  @Post()
  mutatePost(): never {
    throw new ForbiddenException('Недостаточно прав');
  }

  @Patch()
  mutatePatch(): never {
    throw new ForbiddenException('Недостаточно прав');
  }

  @Delete()
  mutateDelete(): never {
    throw new ForbiddenException('Недостаточно прав');
  }
}
