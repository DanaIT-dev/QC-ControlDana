import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Body,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { RegistryService } from './registry.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  @Post('imported-engineer-references/:referenceId/resolve')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  resolveImportedEngineer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('referenceId') referenceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    if (!UUID_PATTERN.test(referenceId)) {
      throw new NotFoundException('Запись не найдена');
    }
    return this.registryService.resolveImportedEngineer(user, referenceId, body, request);
  }
}
