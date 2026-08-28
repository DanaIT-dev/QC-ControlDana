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
import { NotificationMutationRateLimitGuard } from './notification-rate-limit.guard';
import { NotificationsService } from './notifications.service';

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
@RequireCapability('MANAGE_NOTIFICATION_SETTINGS')
export class NotificationSettingsController {
  constructor(
    @Inject(NotificationsService) private readonly notificationsService: NotificationsService,
  ) {}

  @Get()
  settings() {
    return this.notificationsService.settings();
  }

  @Patch()
  @UseGuards(BrowserOriginGuard, CsrfGuard, NotificationMutationRateLimitGuard)
  patch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.notificationsService.patchSettings(user, body, request);
  }
}
