import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { type PrismaClient } from '@sgr-registry/database';
import { isScanTerminal, shouldFailScan } from '@sgr-registry/domain';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { PRISMA_CLIENT } from '../auth/prisma.tokens';
import { writeAuditLog, toJsonValue } from '../common/audit-writer';
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
        await this.prisma.attachment.update({
          where: { id: attachmentId },
          data: {
            status: 'READY',
            scannedAt: new Date(),
            scanEngine: result.engine,
            scanSignature: null,
            failureCode: null,
          },
        });
        await writeAuditLog(this.prisma, {
          actor: { id: attachment.uploadedById, fullName: 'system:clamav' },
          action: 'ATTACHMENT_SCAN_PASSED',
          entityType: 'ATTACHMENT',
          entityId: attachmentId,
          newValue: toJsonValue({ status: 'READY' }),
          source: 'SYSTEM',
        });
        return;
      }
      await this.prisma.attachment.update({
        where: { id: attachmentId },
        data: {
          status: 'REJECTED',
          scannedAt: new Date(),
          scanEngine: result.engine,
          scanSignature: result.signature,
          rejectionReason: 'Обнаружена угроза',
          objectKey: null,
        },
      });
      await writeAuditLog(this.prisma, {
        actor: { id: attachment.uploadedById, fullName: 'system:clamav' },
        action: 'ATTACHMENT_REJECTED',
        entityType: 'ATTACHMENT',
        entityId: attachmentId,
        newValue: toJsonValue({ status: 'REJECTED', scanSignature: result.signature }),
        source: 'SYSTEM',
      });
      await this.store.deleteExact(attachment.objectKey);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'scan failed');
      if (shouldFailScan(attempt)) {
        await this.prisma.attachment.update({
          where: { id: attachmentId },
          data: { status: 'SCAN_FAILED', failureCode: 'SCANNER_UNAVAILABLE' },
        });
        await writeAuditLog(this.prisma, {
          actor: { id: attachment.uploadedById, fullName: 'system:clamav' },
          action: 'ATTACHMENT_SCAN_FAILED',
          entityType: 'ATTACHMENT',
          entityId: attachmentId,
          newValue: toJsonValue({ status: 'SCAN_FAILED' }),
          source: 'SYSTEM',
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
}
