import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { ProposalSlot } from '@sgr-registry/contracts';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { OperationsService } from './operations.service.js';

@Controller('defects')
@UseGuards(AuthenticationGuard, BrowserOriginGuard, CsrfGuard, CapabilityGuard)
export class DefectsCommandController {
  constructor(@Inject(OperationsService) private readonly operationsService: OperationsService) {}

  @Put(':defectItemId/assignments')
  @RequireCapability('EDIT_ASSIGNMENTS')
  assignments(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.replaceAssignments(user, defectItemId, body, request);
  }

  @Patch(':defectItemId/deadlines')
  @RequireCapability('EDIT_PLANNED_DEADLINE', 'EDIT_CLAIM_DEADLINE', 'EDIT_THIRD_PARTY_DEADLINE')
  deadlines(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.patchDeadlines(user, defectItemId, body, request);
  }

  @Post(':defectItemId/complete')
  @HttpCode(200)
  @RequireCapability('COMPLETE_DEFECT')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.complete(user, defectItemId, body, request);
  }

  @Post(':defectItemId/submit-for-inspection')
  @HttpCode(200)
  @RequireCapability('SUBMIT_DEFECT_FOR_INSPECTION')
  submitForInspection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.submitForInspection(user, defectItemId, body, request);
  }

  @Post(':defectItemId/accept-repair')
  @HttpCode(200)
  @RequireCapability('ACCEPT_DEFECT_REPAIR')
  acceptRepair(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.acceptRepair(user, defectItemId, body, request);
  }

  @Post(':defectItemId/reject-repair')
  @HttpCode(200)
  @RequireCapability('REJECT_DEFECT_REPAIR')
  rejectRepair(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.rejectRepair(user, defectItemId, body, request);
  }

  @Post(':defectItemId/reopen')
  @HttpCode(200)
  @RequireCapability('REOPEN_DEFECT')
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.reopen(user, defectItemId, body, request);
  }

  @Put(':defectItemId/proposals/:slot')
  @RequireCapability('MANAGE_PROPOSALS')
  upsertProposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Param('slot') slot: ProposalSlot,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.upsertProposal(user, defectItemId, slot, body, request);
  }

  @Post(':defectItemId/proposals/:slot/archive')
  @HttpCode(200)
  @RequireCapability('MANAGE_PROPOSALS')
  archiveProposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Param('slot') slot: ProposalSlot,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.archiveProposal(user, defectItemId, slot, body, request);
  }

  @Post(':defectItemId/proposals/:slot/restore')
  @HttpCode(200)
  @RequireCapability('MANAGE_PROPOSALS')
  restoreProposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Param('slot') slot: ProposalSlot,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.operationsService.restoreProposal(user, defectItemId, slot, body, request);
  }
}
