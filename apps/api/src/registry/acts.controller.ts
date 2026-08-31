import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { OperationsService } from '../operations/operations.service';
import { RegistryService } from './registry.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('acts')
@UseGuards(AuthenticationGuard)
export class ActsController {
  constructor(
    @Inject(RegistryService) private readonly registryService: RegistryService,
    @Inject(OperationsService) private readonly operationsService: OperationsService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard)
  @RequireCapability('CREATE_ACT')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.createAct(user, body, request);
  }

  @Get(':actId/history')
  @UseGuards(CapabilityGuard)
  @RequireCapability('VIEW_HISTORY', 'VIEW_ASSIGNED_HISTORY')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.operationsService.actHistory(user, actId, query);
  }

  @Patch(':actId/header')
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard)
  @RequireCapability('EDIT_ACT_HEADER')
  patchHeader(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.patchHeader(user, actId, body, request);
  }

  @Post(':actId/defects')
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard)
  @RequireCapability('ADD_DEFECT')
  addDefect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.addDefect(user, actId, body, request);
  }

  @Get(':actId')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('actId') actId: string) {
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    return this.registryService.actDetail(user, actId);
  }
}
