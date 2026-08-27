import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import { getPrismaClient, Prisma } from '@sgr-registry/database';
import { assertAuditPayloadSafe, isScanTerminal, shouldFailScan } from '@sgr-registry/domain';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { ClamdClient } from './clamd.client';
import { createS3Client, ObjectStore, resolveAttachmentBucket } from './object-store';

export const ATTACHMENT_QUEUE = 'sgr-attachments';
export const ATTACHMENT_SCAN_JOB = 'attachment.scan';
export const ATTACHMENT_RECOVERY_JOB = 'attachment.recover';

@Processor(ATTACHMENT_QUEUE)
export class AttachmentScanProcessor extends WorkerHost {
  private readonly logger = new Logger(AttachmentScanProcessor.name);

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
    const prisma = getPrismaClient(config.DATABASE_URL);
    const store = new ObjectStore(createS3Client(config), resolveAttachmentBucket(config));
    const clamd = new ClamdClient(config.CLAMD_HOST, config.CLAMD_PORT);

    const acquired = await prisma.attachment.updateMany({
      where: { id: attachmentId, status: { in: ['PENDING_SCAN', 'SCANNING'] } },
      data: { status: 'SCANNING' },
    });
    const attachment = await prisma.attachment.findUnique({ where: { id: attachmentId } });
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
      const object = await store.getStream(attachment.objectKey);
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
        await prisma.attachment.update({
          where: { id: attachmentId },
          data: {
            status: 'READY',
            scannedAt: new Date(),
            scanEngine: result.engine,
            scanSignature: null,
            failureCode: null,
          },
        });
        await writeSystemAudit(prisma, {
          actorUserId: attachment.uploadedById,
          action: 'ATTACHMENT_SCAN_PASSED',
          entityId: attachmentId,
          newValue: { status: 'READY' },
        });
        return;
      }
      await prisma.attachment.update({
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
      await writeSystemAudit(prisma, {
        actorUserId: attachment.uploadedById,
        action: 'ATTACHMENT_REJECTED',
        entityId: attachmentId,
        newValue: { status: 'REJECTED', scanSignature: result.signature },
      });
      await store.deleteExact(attachment.objectKey);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'scan failed');
      if (shouldFailScan(attempt)) {
        await prisma.attachment.update({
          where: { id: attachmentId },
          data: { status: 'SCAN_FAILED', failureCode: 'SCANNER_UNAVAILABLE' },
        });
        await writeSystemAudit(prisma, {
          actorUserId: attachment.uploadedById,
          action: 'ATTACHMENT_SCAN_FAILED',
          entityId: attachmentId,
          newValue: { status: 'SCAN_FAILED' },
        });
        return;
      }
      await prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: 'PENDING_SCAN' },
      });
      throw error;
    }
  }
}

async function writeSystemAudit(
  prisma: ReturnType<typeof getPrismaClient>,
  input: {
    actorUserId: string;
    action: string;
    entityId: string;
    newValue: Record<string, unknown>;
  },
) {
  assertAuditPayloadSafe(input.newValue);
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      actorName: 'system:clamav',
      action: input.action,
      entityType: 'ATTACHMENT',
      entityId: input.entityId,
      newValue: JSON.parse(JSON.stringify(input.newValue)) as Prisma.InputJsonValue,
      source: 'SYSTEM',
    },
  });
}
