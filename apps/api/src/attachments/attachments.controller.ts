import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { CapabilityGuard, RequireCapability } from '../common/capability.guard.js';
import { buildContentDisposition, ValidationError } from '@sgr-registry/domain';
import '@fastify/multipart';
import { SkipRlsTransaction } from '../auth/skip-rls-transaction.js';
import { AttachmentsService } from './attachments.service.js';

@Controller()
@UseGuards(AuthenticationGuard, CapabilityGuard)
export class AttachmentsController {
  constructor(@Inject(AttachmentsService) private readonly attachments: AttachmentsService) {}

  @Get('acts/:actId/attachments')
  @RequireCapability('VIEW_ATTACHMENTS')
  listAct(@CurrentUser() user: AuthenticatedUser, @Param('actId') actId: string) {
    return this.attachments.listForAct(user, actId);
  }

  @Post('acts/:actId/attachments')
  @HttpCode(202)
  @SkipRlsTransaction()
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('UPLOAD_ACT_ATTACHMENT')
  async uploadAct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('actId') actId: string,
    @Req() request: FastifyRequest,
  ) {
    const { file, category } = await readUpload(request);
    const result = await this.attachments.uploadForAct(user, actId, request, file, category);
    return result.body;
  }

  @Get('defects/:defectItemId/attachments')
  @RequireCapability('VIEW_ATTACHMENTS')
  listDefect(@CurrentUser() user: AuthenticatedUser, @Param('defectItemId') defectItemId: string) {
    return this.attachments.listForDefect(user, defectItemId);
  }

  @Post('defects/:defectItemId/attachments')
  @HttpCode(202)
  @SkipRlsTransaction()
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('UPLOAD_DEFECT_ATTACHMENT')
  async uploadDefect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('defectItemId') defectItemId: string,
    @Req() request: FastifyRequest,
  ) {
    const { file, category } = await readUpload(request);
    const result = await this.attachments.uploadForDefect(
      user,
      defectItemId,
      request,
      file,
      category,
    );
    return result.body;
  }

  @Get('proposals/:proposalId/attachments')
  @RequireCapability('VIEW_ATTACHMENTS')
  listProposal(@CurrentUser() user: AuthenticatedUser, @Param('proposalId') proposalId: string) {
    return this.attachments.listForProposal(user, proposalId);
  }

  @Post('proposals/:proposalId/attachments')
  @HttpCode(202)
  @SkipRlsTransaction()
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('UPLOAD_PROPOSAL_ATTACHMENT')
  async uploadProposal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('proposalId') proposalId: string,
    @Req() request: FastifyRequest,
  ) {
    const { file, category } = await readUpload(request);
    const result = await this.attachments.uploadForProposal(
      user,
      proposalId,
      request,
      file,
      category,
    );
    return result.body;
  }

  @Get('attachments/:attachmentId')
  @RequireCapability('VIEW_ATTACHMENTS')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('attachmentId') attachmentId: string) {
    return this.attachments.getMetadata(user, attachmentId);
  }

  @Get('attachments/:attachmentId/content')
  @SkipRlsTransaction()
  @RequireCapability('DOWNLOAD_ATTACHMENT')
  @Header('X-Content-Type-Options', 'nosniff')
  @Header('Cache-Control', 'private, no-store')
  async content(
    @CurrentUser() user: AuthenticatedUser,
    @Param('attachmentId') attachmentId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
    const result = await this.attachments.content(user, attachmentId, range);
    const inline = result.mimeType.startsWith('image/') || result.mimeType === 'application/pdf';
    reply.removeHeader('x-frame-options');
    reply.removeHeader('content-security-policy');
    reply.header('Content-Type', result.mimeType);
    reply.header('Content-Disposition', buildContentDisposition(result.filename, inline));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    if (result.contentRange) {
      reply.header('Content-Range', result.contentRange);
      reply.header('Accept-Ranges', 'bytes');
    }
    return reply.status(result.status).send(result.body);
  }

  @Post('attachments/:attachmentId/archive')
  @HttpCode(200)
  @UseGuards(BrowserOriginGuard, CsrfGuard)
  @RequireCapability('ARCHIVE_ATTACHMENT')
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('attachmentId') attachmentId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.attachments.archive(user, attachmentId, body, request);
  }
}

async function readUpload(request: FastifyRequest) {
  const file = await request.file();
  if (!file) {
    throw new ValidationError('file', 'Файл не передан');
  }
  const categoryField = file.fields?.category;
  const raw = Array.isArray(categoryField) ? categoryField[0] : categoryField;
  const category = raw && 'value' in raw ? String(raw.value) : 'OTHER';
  return {
    file: { filename: file.filename, mimetype: file.mimetype, file: file.file },
    category,
  };
}
