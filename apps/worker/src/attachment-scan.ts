import { loadConfig } from '@sgr-registry/config';
import { Prisma, type PrismaClient, withWorkerDbContext } from '@sgr-registry/database';
import { isScanTerminal, shouldFailScan } from '@sgr-registry/domain';
import { notifyAttachmentScan, OutboxWriter, toJsonValue, writeAuditLog } from '@sgr-registry/jobs';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { ClamdClient } from './clamd.client';
import { ObjectStore } from './object-store';

export const ATTACHMENT_SCAN_JOB = 'attachment.scan';
export const ATTACHMENT_RECOVERY_JOB = 'attachment.recover';

export async function processAttachmentJob(
  job: Job<{ attachmentId?: string }>,
  deps: {
    prisma: PrismaClient;
    store: ObjectStore;
    outboxWriter: OutboxWriter;
    rootPrisma: PrismaClient;
    secret: string;
  },
): Promise<{ ok: boolean }> {
  if (job.name === ATTACHMENT_RECOVERY_JOB) {
    return { ok: true };
  }
  const attachmentId = job.data.attachmentId;
  if (job.name !== ATTACHMENT_SCAN_JOB || !attachmentId) {
    return { ok: true };
  }
  await scanAttachment(attachmentId, job.attemptsMade + 1, deps);
  return { ok: true };
}

async function scanAttachment(
  attachmentId: string,
  attempt: number,
  deps: {
    prisma: PrismaClient;
    store: ObjectStore;
    outboxWriter: OutboxWriter;
    rootPrisma: PrismaClient;
    secret: string;
  },
): Promise<void> {
  const config = loadConfig();
  const clamd = new ClamdClient(config.CLAMD_HOST, config.CLAMD_PORT);
  const inWorkerTx = <T>(fn: () => Promise<T>): Promise<T> =>
    withWorkerDbContext({ prisma: deps.rootPrisma, secret: deps.secret, callback: fn });

  const acquired = await inWorkerTx(() =>
    deps.prisma.attachment.updateMany({
      where: { id: attachmentId, status: { in: ['PENDING_SCAN', 'SCANNING'] } },
      data: { status: 'SCANNING' },
    }),
  );
  const attachment = await inWorkerTx(() =>
    deps.prisma.attachment.findUnique({ where: { id: attachmentId } }),
  );
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
    const object = await deps.store.getStream(attachment.objectKey);
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
      await inWorkerTx(() =>
        finishScan(deps, attachment, {
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
        }),
      );
      return;
    }
    await inWorkerTx(() =>
      finishScan(deps, attachment, {
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
      }),
    );
    await deps.store.deleteExact(attachment.objectKey);
  } catch (error) {
    if (shouldFailScan(attempt)) {
      await inWorkerTx(() =>
        finishScan(deps, attachment, {
          type: 'ATTACHMENT_SCAN_FAILED',
          action: 'ATTACHMENT_SCAN_FAILED',
          data: { status: 'SCAN_FAILED', failureCode: 'SCANNER_UNAVAILABLE' },
          audit: { status: 'SCAN_FAILED' },
        }),
      );
      return;
    }
    await inWorkerTx(() =>
      deps.prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: 'PENDING_SCAN' },
      }),
    );
    throw error;
  }
}

async function finishScan(
  deps: { prisma: PrismaClient; outboxWriter: OutboxWriter },
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
  const outboxIds = await deps.prisma.$transaction(async (tx) => {
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
    const ids = await notifyAttachmentScan(deps.outboxWriter, tx, {
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
  await deps.outboxWriter.enqueue(outboxIds);
}
