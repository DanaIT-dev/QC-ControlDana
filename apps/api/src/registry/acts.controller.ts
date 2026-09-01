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
import { OperationsService } from '../operations/operations.service';
import { RegistryService } from './registry.service';
import { ActChatService } from './act-chat.service';
import { ActChatRateLimitGuard } from './act-chat-rate-limit.guard';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('acts')
@UseGuards(AuthenticationGuard)
export class ActsController {
  constructor(
    @Inject(RegistryService) private readonly registryService: RegistryService,
    @Inject(OperationsService) private readonly operationsService: OperationsService,
    @Inject(ActChatService) private readonly actChatService: ActChatService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard)
  @RequireCapability('CREATE_ACT')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.createAct(user, body, request);
  }

  @Get(':actId/chat/mention-candidates')
  @UseGuards(CapabilityGuard)
  @RequireCapability('VIEW_ACT_CHAT')
  chatMentionCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.actChatService.mentionCandidates(user, actId, query);
  }

  @Get(':actId/chat')
  @UseGuards(CapabilityGuard)
  @RequireCapability('VIEW_ACT_CHAT')
  chatList(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.actChatService.list(user, actId, query);
  }

  @Post(':actId/chat')
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard, ActChatRateLimitGuard)
  @RequireCapability('VIEW_ACT_CHAT')
  createChatMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.actChatService.create(user, actId, body, request);
  }

  @Get(':actId/history')
  @UseGuards(CapabilityGuard)
  @RequireCapability('VIEW_HISTORY', 'VIEW_ASSIGNED_HISTORY')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Query() query: Record<string, unknown>,
  ) {
    return this.operationsService.actHistory(user, actId, query);
  }

  @Patch(':actId/header')
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard)
  @RequireCapability('EDIT_ACT_HEADER')
  patchHeader(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.patchHeader(user, actId, body, request);
  }

  @Post(':actId/defects')
  @HttpCode(201)
  @UseGuards(BrowserOriginGuard, CsrfGuard, CapabilityGuard)
  @RequireCapability('ADD_DEFECT')
  addDefect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.addDefect(user, actId, body, request);
  }

  @Get(':actId')
  @UseGuards(CapabilityGuard)
  @RequireCapability('VIEW_ALL_ACTS', 'VIEW_ASSIGNED_DEFECTS')
  detail(@CurrentUser() user: AuthenticatedUser, @Param('actId') actId: string) {
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    return this.registryService.actDetail(user, actId);
  }
}
