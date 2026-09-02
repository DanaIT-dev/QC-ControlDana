import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
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
import { ObjectCreateRateLimitGuard } from './object-create-rate-limit.guard';
import { ObjectsService } from './objects.service';

@Controller('objects')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class ObjectsController {
  constructor(@Inject(ObjectsService) private readonly objectsService: ObjectsService) {}

  @Get()
  @RequireCapability('VIEW_REFERENCE_DATA')
  list(@CurrentUser() user: AuthenticatedUser, @Req() request: FastifyRequest) {
    return this.objectsService.list(user, (request.query ?? {}) as Record<string, unknown>);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('CREATE_PROPERTY_OBJECT')
  @UseGuards(BrowserOriginGuard, CsrfGuard, ObjectCreateRateLimitGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.objectsService.create(user, body, request);
  }

  @Patch(':objectId/responsible-engineer')
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  linkResponsibleEngineer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('objectId') objectId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.objectsService.linkResponsibleEngineer(user, objectId, body, request);
  }
}
