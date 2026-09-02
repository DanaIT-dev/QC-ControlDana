import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
import { SuperAdminMutationRateLimitGuard } from './super-admin-rate-limit.guard';
import { SuperAdminService } from './super-admin.service';

@Controller('super-admin')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class SuperAdminController {
  constructor(@Inject(SuperAdminService) private readonly superAdminService: SuperAdminService) {}

  @Get('admins')
  @RequireCapability('MANAGE_ADMIN_GRANTS')
  listAdmins(@Query() query: Record<string, unknown>) {
    return this.superAdminService.listAdmins(query);
  }

  @Get('eligible-users')
  @RequireCapability('MANAGE_ADMIN_GRANTS')
  listEligible(@Query() query: Record<string, unknown>) {
    return this.superAdminService.listEligible(query);
  }

  @Post('users')
  @HttpCode(201)
  @RequireCapability('CREATE_UNASSIGNED_USER')
  @UseGuards(BrowserOriginGuard, CsrfGuard, SuperAdminMutationRateLimitGuard)
  createUser(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.superAdminService.createPendingUser(user, body, request);
  }

  @Post('admins/:userId')
  @HttpCode(200)
  @RequireCapability('MANAGE_ADMIN_GRANTS')
  @UseGuards(BrowserOriginGuard, CsrfGuard, SuperAdminMutationRateLimitGuard)
  grant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.superAdminService.grant(user, userId, body, request);
  }

  @Delete('admins/:userId')
  @HttpCode(200)
  @RequireCapability('MANAGE_ADMIN_GRANTS')
  @UseGuards(BrowserOriginGuard, CsrfGuard, SuperAdminMutationRateLimitGuard)
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.superAdminService.revoke(user, userId, body, request);
  }
}
