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
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { BrowserOriginGuard } from '../auth/browser-origin.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('MANAGE_USERS')
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.usersService.list(query);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.create(user, body, request);
  }

  @Patch(':userId')
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
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  resetPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.usersService.resetPassword(user, userId, body, request);
  }

  @Get(':userId/history')
  history(@Param('userId') userId: string, @Query() query: Record<string, unknown>) {
    return this.usersService.history(userId, query);
  }
}
