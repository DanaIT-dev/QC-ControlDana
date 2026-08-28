import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { Prisma, type PrismaClient } from '@sgr-registry/database';
import { isScanTerminal, shouldFailScan } from '@sgr-registry/domain';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { PRISMA_CLIENT } from '../auth/prisma.tokens';
import { writeAuditLog, toJsonValue } from '../common/audit-writer';
import { notifyAttachmentScan } from '../notifications/defect-outbox';
import { OutboxWriter } from '../notifications/outbox.writer';
import {
  ATTACHMENT_QUEUE,
  ATTACHMENT_RECOVERY_JOB,
  ATTACHMENT_SCAN_JOB,
} from './attachment.constants';
import { ClamdClient } from './clamd.client';
import { ObjectStore } from './object-store';

@Processor(ATTACHMENT_QUEUE)
export class AttachmentScanProcessor extends WorkerHost {
  private readonly logger = new Logger(AttachmentScanProcessor.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(ObjectStore) private readonly store: ObjectStore,
    @Inject(OutboxWriter) private readonly outboxWriter: OutboxWriter,
  ) {
    super();
  }

  async process(job: Job<{ attachmentId?: string }>): Promise<{ ok: boolean }> {
    if (job.name === ATTACHMENT_RECOVERY_JOB) {
      return { ok: true };
    }
    const attachmentId = job.data.attachmentId;
    if (job.name !== ATTACHMENT_SCAN_JOB || !attachmentId) {
      return { ok: true };
    }
    await this.scan(attachmentId, job.attemptsMade + 1);
    return { ok: true };
  }

  private async scan(attachmentId: string, attempt: number): Promise<void> {
    const config = loadConfig();
    const clamd = new ClamdClient(config.CLAMD_HOST, config.CLAMD_PORT);
    const acquired = await this.prisma.attachment.updateMany({
      where: { id: attachmentId, status: { in: ['PENDING_SCAN', 'SCANNING'] } },
      data: { status: 'SCANNING' },
    });
    const attachment = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!attachment) {
      return;
    }
    if (acquired.count === 0 && isScanTerminal(attachment.status)) {
      return;
    }
    if (!attachment.objectKey) {
      return;
    }

    try {
      const object = await this.store.getStream(attachment.objectKey);
      const body = object.Body;
      if (!body) {
        throw new Error('empty object body');
      }
      const stream =
        body instanceof Readable
          ? body
          : Readable.fromWeb(
              (body as { transformToWebStream: () => ReadableStream }).transformToWebStream(),
            );
      const result = await clamd.scanStream(stream);
      if (result.clean) {
        await this.finishScan(attachment, {
          type: 'ATTACHMENT_READY',
          action: 'ATTACHMENT_SCAN_PASSED',
          data: {
            status: 'READY',
            scannedAt: new Date(),
            scanEngine: result.engine,
            scanSignature: null,
            failureCode: null,
          },
          audit: { status: 'READY' },
        });
        return;
      }
      await this.finishScan(attachment, {
        type: 'ATTACHMENT_REJECTED',
        action: 'ATTACHMENT_REJECTED',
        data: {
          status: 'REJECTED',
          scannedAt: new Date(),
          scanEngine: result.engine,
          scanSignature: result.signature,
          rejectionReason: 'Обнаружена угроза',
          objectKey: null,
        },
        audit: { status: 'REJECTED', scanSignature: result.signature },
      });
      await this.store.deleteExact(attachment.objectKey);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'scan failed');
      if (shouldFailScan(attempt)) {
        await this.finishScan(attachment, {
          type: 'ATTACHMENT_SCAN_FAILED',
          action: 'ATTACHMENT_SCAN_FAILED',
          data: { status: 'SCAN_FAILED', failureCode: 'SCANNER_UNAVAILABLE' },
          audit: { status: 'SCAN_FAILED' },
        });
        return;
      }
      await this.prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: 'PENDING_SCAN' },
      });
      throw error;
    }
  }

  private async finishScan(
    attachment: {
      id: string;
      actId: string | null;
      defectItemId: string | null;
      proposalId: string | null;
      uploadedById: string;
    },
    input: {
      type: 'ATTACHMENT_READY' | 'ATTACHMENT_REJECTED' | 'ATTACHMENT_SCAN_FAILED';
      action: string;
      data: Record<string, unknown>;
      audit: Record<string, unknown>;
    },
  ): Promise<void> {
    const outboxIds = await this.prisma.$transaction(async (tx) => {
      await tx.attachment.update({
        where: { id: attachment.id },
        data: input.data as Prisma.AttachmentUpdateInput,
      });
      const uploader = await tx.user.findUnique({
        where: { id: attachment.uploadedById },
        select: { role: true },
      });
      const proposal = attachment.proposalId
        ? await tx.proposal.findUnique({
            where: { id: attachment.proposalId },
            select: { slot: true },
          })
        : null;
      const ids = await notifyAttachmentScan(this.outboxWriter, tx, {
        type: input.type,
        attachmentId: attachment.id,
        actId: attachment.actId,
        defectItemId: attachment.defectItemId,
        uploadedById: attachment.uploadedById,
        proposalSlot: proposal?.slot ?? null,
        uploaderRole: uploader?.role,
      });
      await writeAuditLog(tx, {
        actor: { id: attachment.uploadedById, fullName: 'system:clamav' },
        action: input.action,
        entityType: 'ATTACHMENT',
        entityId: attachment.id,
        newValue: toJsonValue(input.audit),
        source: 'SYSTEM',
      });
      return ids;
    });
    await this.outboxWriter.enqueue(outboxIds);
  }
}
