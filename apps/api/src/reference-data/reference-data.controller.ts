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
import { ReferenceDataService, type ReferenceKind } from './reference-data.service';

@Controller('reference-data')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('MANAGE_REFERENCE_DATA')
export class ReferenceDataController {
  constructor(
    @Inject(ReferenceDataService) private readonly referenceDataService: ReferenceDataService,
  ) {}

  @Get(':kind')
  list(@Param('kind') kind: ReferenceKind, @Query() query: Record<string, unknown>) {
    return this.referenceDataService.list(assertKind(kind), query);
  }

  @Post(':kind')
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
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
