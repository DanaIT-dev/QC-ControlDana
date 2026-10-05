import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { UsersService } from './users.service.js';

@Controller('users')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  @Get()
  @RequireCapability(
    'MANAGE_USERS',
    'VIEW_ALL_BUSINESS_DATA',
    'CREATE_UNASSIGNED_USER',
    'VIEW_HISTORY',
  )
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, unknown>) {
    return this.usersService.list(user, query);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.create(user, body, request);
  }

  @Post('me/complete-profile')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  completeProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.completeOwnProfile(user, body, request);
  }

  @Patch(':userId/employment')
  @RequireCapability('MANAGE_USERS', 'VIEW_ALL_ACTS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  updateEmployment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.updateEmployment(user, userId, body, request);
  }

  @Patch(':userId/profile')
  @RequireCapability('MANAGE_USERS', 'VIEW_ALL_BUSINESS_DATA')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.updateProfile(user, userId, body, request);
  }

  @Patch(':userId')
  @RequireCapability('MANAGE_USERS', 'VIEW_ALL_BUSINESS_DATA')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.update(user, userId, body, request);
  }

  @Post(':userId/archive')
  @HttpCode(200)
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.archive(user, userId, body, request);
  }

  @Post(':userId/restore')
  @HttpCode(200)
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  restore(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.restore(user, userId, body, request);
  }

  @Post(':userId/reset-password')
  @HttpCode(200)
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  resetPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.resetPassword(user, userId, body, request);
  }

  @Get(':userId/organization-memberships')
  @RequireCapability('MANAGE_USERS', 'VIEW_ALL_BUSINESS_DATA')
  organizationMemberships(@CurrentUser() user: AuthenticatedUser, @Param('userId') userId: string) {
    return this.usersService.listOrganizationMemberships(user, userId);
  }

  @Post(':userId/organization-memberships')
  @HttpCode(201)
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  assignOrganizationMembership(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.assignOrganizationMembership(user, userId, body, request);
  }

  @Post(':userId/organization-memberships/:membershipId/revoke')
  @HttpCode(200)
  @RequireCapability('MANAGE_USERS')
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  revokeOrganizationMembership(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('membershipId') membershipId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.revokeOrganizationMembership(user, userId, membershipId, request);
  }

  @Get(':userId/history')
  @RequireCapability('MANAGE_USERS', 'VIEW_ALL_BUSINESS_DATA')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.usersService.history(user, userId, query);
  }
}
