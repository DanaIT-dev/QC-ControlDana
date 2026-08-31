import {
  Body,
  Controller,
  ForbiddenException,
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
import { canAccessReferenceKind } from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { ReferenceDataService, type ReferenceKind } from './reference-data.service';

@Controller('reference-data')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class ReferenceDataController {
  constructor(
    @Inject(ReferenceDataService) private readonly referenceDataService: ReferenceDataService,
  ) {}

  @Get(':kind')
  @RequireCapability('VIEW_REFERENCE_DATA', 'MANAGE_REFERENCE_DATA')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Query() query: Record<string, unknown>,
  ) {
    return this.referenceDataService.list(assertReadableKind(kind, user.role), query);
  }

  @Post(':kind')
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.referenceDataService.create(assertKind(kind), user, body, request);
  }

  @Patch(':kind/:id')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.referenceDataService.update(assertKind(kind), id, user, body, request);
  }

  @Post(':kind/:id/archive')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA')
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.referenceDataService.archive(assertKind(kind), id, user, body, request);
  }

  @Post(':kind/:id/restore')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA')
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.referenceDataService.restore(assertKind(kind), id, user, body, request);
  }

  @Get(':kind/:id/history')
  @RequireCapability('MANAGE_REFERENCE_DATA')
  history(
    @Param('kind') kind: ReferenceKind,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.referenceDataService.history(assertKind(kind), id, query);
  }
}

function assertKind(kind: string): ReferenceKind {
  if (
    kind === 'property-objects' ||
    kind === 'organizations' ||
    kind === 'work-types' ||
    kind === 'defect-types'
  ) {
    return kind;
  }
  throw new NotFoundException('Запись не найдена');
}

function assertReadableKind(kind: string, role: AuthenticatedUser['role']): ReferenceKind {
  const asserted = assertKind(kind);
  if (!canAccessReferenceKind(role, asserted)) {
    throw new ForbiddenException('Недостаточно прав');
  }
  return asserted;
}
