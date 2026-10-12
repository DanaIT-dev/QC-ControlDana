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
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { DirectoryMutateRateLimitGuard } from './directory-mutate-rate-limit.guard.js';
import { ReferenceDataService, type ReferenceKind } from './reference-data.service.js';

@Controller('reference-data')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class ReferenceDataController {
  constructor(
    @Inject(ReferenceDataService) private readonly referenceDataService: ReferenceDataService,
  ) {}

  @Get(':kind')
  @RequireCapability(
    'VIEW_REFERENCE_DATA',
    'MANAGE_REFERENCE_DATA',
    'MANAGE_CONSTRUCTION_WORK_DIRECTORY',
    'VIEW_CONSTRUCTION_WORK_DIRECTORY',
  )
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Query() query: Record<string, unknown>,
  ) {
    return this.referenceDataService.list(assertReadableKind(kind, user.role), query);
  }

  @Post(':kind')
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard, DirectoryMutateRateLimitGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA', 'MANAGE_PROPOSALS')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.referenceDataService.create(assertKind(kind), user, body, request);
  }

  @Patch(':kind/:id')
  @UseGuards(BrowserOriginGuard, CsrfGuard, DirectoryMutateRateLimitGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA', 'MANAGE_CONSTRUCTION_WORK_DIRECTORY')
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
  @UseGuards(BrowserOriginGuard, CsrfGuard, DirectoryMutateRateLimitGuard)
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

  @Post(':kind/:id/delete')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard, DirectoryMutateRateLimitGuard)
  @RequireCapability('MANAGE_REFERENCE_DATA', 'MANAGE_CONSTRUCTION_WORK_DIRECTORY')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.referenceDataService.remove(assertKind(kind), id, user, body, request);
  }

  @Post(':kind/:id/restore')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard, DirectoryMutateRateLimitGuard)
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
  @RequireCapability('MANAGE_REFERENCE_DATA', 'VIEW_ALL_BUSINESS_DATA')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: ReferenceKind,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.referenceDataService.history(assertReadableKind(kind, user.role), id, query);
  }
}

function assertKind(kind: string): ReferenceKind {
  if (
    kind === 'property-objects' ||
    kind === 'organizations' ||
    kind === 'work-types' ||
    kind === 'defect-types' ||
    kind === 'construction-work-organizations'
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
