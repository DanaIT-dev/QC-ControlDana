import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
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
}
