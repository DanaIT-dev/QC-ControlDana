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
import { NotificationMutationRateLimitGuard } from './notification-rate-limit.guard.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
@UseGuards(AuthenticationGuard, CapabilityGuard)
@RequireCapability('VIEW_NOTIFICATIONS')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: Record<string, string | undefined>) {
    return this.notificationsService.list(user, query);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.unreadCount(user);
  }

  @Patch(':id/read')
  @UseGuards(BrowserOriginGuard, CsrfGuard, NotificationMutationRateLimitGuard)
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notificationsService.markRead(user, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard, NotificationMutationRateLimitGuard)
  readAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notificationsService.readAll(user);
  }
}

@Controller('system/notification-settings')
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class NotificationSettingsController {
  constructor(
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  @RequireCapability('VIEW_SYSTEM_SETTINGS', 'MANAGE_SYSTEM_SETTINGS')
  settings() {
    return this.notificationsService.settings();
  }

  @Patch()
  @RequireCapability('MANAGE_SYSTEM_SETTINGS')
  @UseGuards(BrowserOriginGuard, CsrfGuard, NotificationMutationRateLimitGuard)
  patch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.notificationsService.patchSettings(user, body, request);
  }
}
