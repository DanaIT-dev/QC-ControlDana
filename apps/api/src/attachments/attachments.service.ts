import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Readable, Transform } from 'node:stream';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { imageSize } from 'image-size';
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '@sgr-registry/config';
import {
  archiveAttachmentRequestSchema,
  type AttachmentItemDto,
  type AttachmentListResponse,
  type AttachmentCategory,
} from '@sgr-registry/contracts';
import { Prisma, type PrismaClient } from '@sgr-registry/database';
import {
  ATTACHMENT_DUPLICATE_STATUSES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_OWNER,
  ALLOWED_ATTACHMENT_MIME_TYPES,
  ALLOWED_ATTACHMENT_EXTENSIONS,
  AttachmentTooLargeError,
  DuplicateValueError,
  StaleWriteError,
  ValidationError,
  assertAllowedFile,
  assertCategoryMatchesOwner,
  assertOwnedObjectKey,
  assertSafeImageDimensions,
  canArchiveAttachment,
  canDownloadAttachment,
  canPreviewAttachment,
  canUploadCategory,
  canViewAttachmentOwner,
  categoriesForOwner,
  createAttachmentObjectKey,
  type AttachmentOwnerRef,
} from '@sgr-registry/domain';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PRISMA_CLIENT } from '../auth/prisma.tokens';
import { writeAuditLog, toJsonValue } from '../common/audit-writer';
import { actorContext } from '../common/request-context';
import { RegistryAccessScope } from '../registry/registry-access-scope';
import { ATTACHMENT_QUEUE, ATTACHMENT_SCAN_JOB } from './attachment.constants';
import { ObjectStore } from './object-store';

type MultipartFile = {
  filename: string;
  mimetype: string;
  file: Readable;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HashingLimiter extends Transform {
  readonly hash = createHash('sha256');
  size = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    this.hash.update(chunk);
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      callback(new AttachmentTooLargeError());
      return;
    }
    callback(null, chunk);
  }
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(ObjectStore) private readonly store: ObjectStore,
    @InjectQueue(ATTACHMENT_QUEUE) private readonly queue: Queue,
  ) {}

  async listForAct(user: AuthenticatedUser, actId: string): Promise<AttachmentListResponse> {
    await this.requireVisibleAct(user, actId);
    return this.list(user, { type: 'ACT', actId });
  }

  async listForDefect(
    user: AuthenticatedUser,
    defectItemId: string,
  ): Promise<AttachmentListResponse> {
    const owner = await this.requireVisibleDefect(user, defectItemId);
    return this.list(user, owner);
  }

  async listForProposal(
    user: AuthenticatedUser,
    proposalId: string,
  ): Promise<AttachmentListResponse> {
    const owner = await this.requireVisibleProposal(user, proposalId);
    return this.list(user, owner);
  }

  async uploadForAct(
    user: AuthenticatedUser,
    actId: string,
    request: FastifyRequest,
    file: MultipartFile,
    category: string,
  ) {
    await this.requireVisibleAct(user, actId);
    return this.upload(user, request, file, category, { type: 'ACT', actId });
  }

  async uploadForDefect(
    user: AuthenticatedUser,
    defectItemId: string,
    request: FastifyRequest,
    file: MultipartFile,
    category: string,
  ) {
    const owner = await this.requireVisibleDefect(user, defectItemId);
    return this.upload(user, request, file, category, owner);
  }

  async uploadForProposal(
    user: AuthenticatedUser,
    proposalId: string,
    request: FastifyRequest,
    file: MultipartFile,
    category: string,
  ) {
    const owner = await this.requireVisibleProposal(user, proposalId);
    return this.upload(user, request, file, category, owner);
  }

  async getMetadata(user: AuthenticatedUser, attachmentId: string): Promise<AttachmentItemDto> {
    const { attachment, owner, assigned } = await this.loadScoped(user, attachmentId);
    return this.toItem(user, attachment, owner, assigned);
  }

  async archive(
    user: AuthenticatedUser,
    attachmentId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    const parsed = archiveAttachmentRequestSchema.parse(body);
    const { attachment, owner, assigned } = await this.loadScoped(user, attachmentId);
    if (
      !canArchiveAttachment({
        role: user.role,
        owner,
        assignedDefectItemIds: assigned,
        uploadedById: attachment.uploadedById,
        actorUserId: user.id,
        status: attachment.status,
      })
    ) {
      throw new NotFoundException('Запись не найдена');
    }
    if (attachment.version !== parsed.expectedVersion) {
      throw new StaleWriteError();
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.attachment.update({
        where: { id: attachment.id, version: parsed.expectedVersion },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          archivedById: user.id,
          archiveReason: parsed.reason,
          version: { increment: 1 },
        },
        include: { uploadedBy: true },
      });
      await writeAuditLog(tx, {
        ...actorContext(user, request),
        action: 'ATTACHMENT_ARCHIVED',
        entityType: 'ATTACHMENT',
        entityId: attachment.id,
        parentEntityType: owner.type,
        parentEntityId: ownerId(owner),
        oldValue: toJsonValue({ status: attachment.status }),
        newValue: toJsonValue({
          status: 'ARCHIVED',
          category: attachment.category,
          slot: owner.type === 'PROPOSAL' ? owner.slot : undefined,
        }),
        reason: parsed.reason,
      });
      return next;
    });
    return this.toItem(user, updated, owner, assigned);
  }

  async content(user: AuthenticatedUser, attachmentId: string, range?: string) {
    const { attachment, owner, assigned } = await this.loadScoped(user, attachmentId);
    if (
      !canDownloadAttachment(attachment.status) ||
      !attachment.objectKey ||
      !attachment.detectedMimeType
    ) {
      throw new NotFoundException('Запись не найдена');
    }
    if (!canViewAttachmentOwner(user.role, owner, assigned)) {
      throw new NotFoundException('Запись не найдена');
    }
    assertOwnedObjectKey(attachment.objectKey, attachment.id);
    const object = await this.store.getStream(attachment.objectKey, range);
    return {
      body: object.Body as Readable,
      mimeType: attachment.detectedMimeType,
      size: attachment.sizeBytes,
      filename: attachment.safeDisplayName,
      contentRange: object.ContentRange,
      status: range && object.ContentRange ? 206 : 200,
    };
  }

  private async list(
    user: AuthenticatedUser,
    owner: AttachmentOwnerRef,
  ): Promise<AttachmentListResponse> {
    const assigned = await this.assignedDefectIds(user, owner.actId);
    const where = ownerWhere(owner);
    const items = await this.prisma.attachment.findMany({
      where: { ...where, status: { notIn: ['UPLOADING', 'ARCHIVED'] } },
      include: { uploadedBy: true },
      orderBy: { createdAt: 'desc' },
    });
    const visible = canViewAttachmentOwner(user.role, owner, assigned) ? items : [];
    const activeCount = visible.filter(
      (item) => item.status !== 'ARCHIVED' && item.status !== 'REJECTED',
    ).length;
    const limits = await this.limits();
    return {
      items: visible.map((item) => this.toItem(user, item, owner, assigned)),
      activeCount,
      limits: {
        maxBytes: limits.maxBytes,
        maxPerOwner: limits.maxPerOwner,
        allowedMimeTypes: [...ALLOWED_ATTACHMENT_MIME_TYPES],
        allowedExtensions: [...ALLOWED_ATTACHMENT_EXTENSIONS],
      },
      allowedMimeTypes: [...ALLOWED_ATTACHMENT_MIME_TYPES],
      capabilities: {
        canUpload: categoriesForOwner(owner.type).some((category) =>
          canUploadCategory(user.role, owner.type, category),
        ),
        canArchive:
          user.role === 'ADMIN' ||
          user.role === 'SGR_MANAGER' ||
          user.role === 'CONTRACTOR_ENGINEER' ||
          user.role === 'RESPONSIBLE_ENGINEER',
        canDownload: true,
      },
    };
  }

  private async upload(
    user: AuthenticatedUser,
    request: FastifyRequest,
    file: MultipartFile,
    rawCategory: string,
    owner: AttachmentOwnerRef,
  ) {
    const category = rawCategory as AttachmentCategory;
    assertCategoryMatchesOwner(owner.type, category);
    if (!canUploadCategory(user.role, owner.type, category)) {
      throw new NotFoundException('Запись не найдена');
    }
    const assigned = await this.assignedDefectIds(user, owner.actId);
    if (!canViewAttachmentOwner(user.role, owner, assigned)) {
      throw new NotFoundException('Запись не найдена');
    }
    const limits = await this.limits();
    const activeCount = await this.prisma.attachment.count({
      where: {
        ...ownerWhere(owner),
        status: { in: [...ATTACHMENT_DUPLICATE_STATUSES, 'UPLOADING'] },
      },
    });
    if (activeCount >= limits.maxPerOwner) {
      throw new ValidationError('file', `Нельзя загрузить больше ${limits.maxPerOwner} файлов`);
    }

    const id = randomUUID();
    const objectKey = createAttachmentObjectKey(id);
    const hasher = new HashingLimiter(limits.maxBytes);
    const sink = new PassThrough();
    hasher.pipe(sink);

    const prefixChunks: Buffer[] = [];
    let prefixSize = 0;
    const source = file.file;
    const first = await new Promise<Buffer>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        prefixChunks.push(chunk);
        prefixSize += chunk.length;
        if (prefixSize >= 16) {
          source.off('data', onData);
          source.off('error', reject);
          source.pause();
          resolve(Buffer.concat(prefixChunks));
        }
      };
      source.once('error', reject);
      source.once('end', () => resolve(Buffer.concat(prefixChunks)));
      source.on('data', onData);
      source.resume();
    });
    if (first.length === 0) {
      throw new ValidationError('file', 'Пустой файл загружать нельзя');
    }

    let detected: ReturnType<typeof assertAllowedFile>;
    try {
      detected = assertAllowedFile({
        filename: file.filename,
        declaredMimeType: file.mimetype,
        magic: first,
        sizeBytes: 1,
      });
    } catch (error) {
      source.destroy();
      throw error;
    }

    if (detected.detectedMimeType.startsWith('image/')) {
      try {
        const info = imageSize(first);
        if (info.width && info.height) {
          assertSafeImageDimensions(info.width, info.height);
        }
      } catch (error) {
        if (
          error instanceof ValidationError ||
          (error as { code?: string }).code === 'UNSAFE_IMAGE'
        ) {
          source.destroy();
          throw error;
        }
      }
    }

    const created = await this.prisma.attachment.create({
      data: {
        id,
        ...ownerIds(owner),
        originalFilename: file.filename,
        safeDisplayName: detected.safeDisplayName,
        objectKey,
        bucket: this.store.bucket,
        sizeBytes: 0,
        declaredMimeType: file.mimetype,
        detectedMimeType: detected.detectedMimeType,
        sha256: 'pending',
        category,
        status: 'UPLOADING',
        uploadedById: user.id,
      },
    });

    try {
      const uploaded = this.store.putStream(objectKey, sink, detected.detectedMimeType);
      hasher.write(first);
      if (source.readableEnded || source.destroyed) {
        hasher.end();
      } else {
        source.resume();
        source.pipe(hasher, { end: true });
      }
      await uploaded;
      const digest = hasher.hash.digest('hex');
      if (hasher.size <= 0) {
        throw new ValidationError('file', 'Пустой файл загружать нельзя');
      }
      if (hasher.size > limits.maxBytes) {
        throw new AttachmentTooLargeError();
      }
      const duplicate = await this.prisma.attachment.findFirst({
        where: {
          ...ownerWhere(owner),
          sha256: digest,
          status: { in: [...ATTACHMENT_DUPLICATE_STATUSES] },
          id: { not: id },
        },
      });
      if (duplicate) {
        await this.store.deleteExact(objectKey);
        await this.prisma.attachment.delete({ where: { id } });
        throw new DuplicateValueError('Такой файл уже загружен');
      }
      await this.store.head(objectKey);
      const ready = await this.prisma.$transaction(async (tx) => {
        const next = await tx.attachment.update({
          where: { id },
          data: {
            status: 'PENDING_SCAN',
            sizeBytes: hasher.size,
            sha256: digest,
            uploadedAt: new Date(),
          },
          include: { uploadedBy: true },
        });
        await writeAuditLog(tx, {
          ...actorContext(user, request),
          action: 'ATTACHMENT_UPLOADED',
          entityType: 'ATTACHMENT',
          entityId: id,
          parentEntityType: owner.type,
          parentEntityId: ownerId(owner),
          newValue: toJsonValue({
            category,
            sizeBytes: hasher.size,
            detectedMimeType: detected.detectedMimeType,
            sha256: digest,
            slot: owner.type === 'PROPOSAL' ? owner.slot : undefined,
          }),
        });
        return next;
      });
      await this.queue.add(
        ATTACHMENT_SCAN_JOB,
        { attachmentId: id },
        {
          jobId: `scan-${id}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
        },
      );
      return { statusCode: 202, body: this.toItem(user, ready, owner, assigned) };
    } catch (error) {
      await this.store.deleteExact(objectKey).catch(() => undefined);
      await this.prisma.attachment.delete({ where: { id: created.id } }).catch(() => undefined);
      throw error;
    }
  }

  private toItem(
    user: AuthenticatedUser,
    attachment: {
      id: string;
      category: AttachmentCategory;
      safeDisplayName: string;
      sizeBytes: number;
      detectedMimeType: string | null;
      status: AttachmentItemDto['status'];
      uploadedById: string;
      uploadedBy: { id: string; fullName: string };
      createdAt: Date;
      scannedAt: Date | null;
      version: number;
    },
    owner: AttachmentOwnerRef,
    assigned: ReadonlySet<string>,
  ): AttachmentItemDto {
    return {
      id: attachment.id,
      ownerType: owner.type,
      ownerId: ownerId(owner),
      category: attachment.category,
      safeDisplayName: attachment.safeDisplayName,
      sizeBytes: String(attachment.sizeBytes),
      detectedMimeType: attachment.detectedMimeType,
      status: attachment.status,
      uploadedBy: { id: attachment.uploadedBy.id, fullName: attachment.uploadedBy.fullName },
      createdAt: attachment.createdAt.toISOString(),
      scannedAt: attachment.scannedAt?.toISOString() ?? null,
      version: attachment.version,
      canPreview: canPreviewAttachment(attachment.status, attachment.detectedMimeType),
      canDownload: canDownloadAttachment(attachment.status),
      canArchive: canArchiveAttachment({
        role: user.role,
        owner,
        assignedDefectItemIds: assigned,
        uploadedById: attachment.uploadedById,
        actorUserId: user.id,
        status: attachment.status,
      }),
    };
  }

  private async loadScoped(user: AuthenticatedUser, attachmentId: string) {
    if (!UUID_PATTERN.test(attachmentId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { uploadedBy: true, proposal: true },
    });
    if (!attachment || attachment.status === 'UPLOADING') {
      throw new NotFoundException('Запись не найдена');
    }
    const owner = await this.ownerFromRow(attachment);
    const assigned = await this.assignedDefectIds(user, owner.actId);
    if (!canViewAttachmentOwner(user.role, owner, assigned)) {
      throw new NotFoundException('Запись не найдена');
    }
    return { attachment, owner, assigned };
  }

  private async ownerFromRow(row: {
    actId: string | null;
    defectItemId: string | null;
    proposalId: string | null;
    proposal: { defectItemId: string; slot: 'A' | 'B' | 'C' } | null;
  }): Promise<AttachmentOwnerRef> {
    if (row.actId) {
      const act = await this.prisma.act.findUnique({
        where: { id: row.actId },
        select: { id: true },
      });
      if (!act) throw new NotFoundException('Запись не найдена');
      return { type: 'ACT', actId: row.actId };
    }
    if (row.defectItemId) {
      const defect = await this.prisma.defectItem.findUnique({
        where: { id: row.defectItemId },
        select: { id: true, actId: true },
      });
      if (!defect) throw new NotFoundException('Запись не найдена');
      return { type: 'DEFECT_ITEM', defectItemId: defect.id, actId: defect.actId };
    }
    if (row.proposalId && row.proposal) {
      const defect = await this.prisma.defectItem.findUnique({
        where: { id: row.proposal.defectItemId },
        select: { actId: true },
      });
      if (!defect) throw new NotFoundException('Запись не найдена');
      return {
        type: 'PROPOSAL',
        proposalId: row.proposalId,
        defectItemId: row.proposal.defectItemId,
        actId: defect.actId,
        slot: row.proposal.slot,
      };
    }
    throw new NotFoundException('Запись не найдена');
  }

  private async requireVisibleAct(user: AuthenticatedUser, actId: string) {
    const scope = new RegistryAccessScope(user);
    const act = await this.prisma.act.findFirst({ where: scope.actVisibleWhere(actId) });
    if (!act) throw new NotFoundException('Запись не найдена');
  }

  private async requireVisibleDefect(
    user: AuthenticatedUser,
    defectItemId: string,
  ): Promise<AttachmentOwnerRef> {
    const scope = new RegistryAccessScope(user);
    const defect = await this.prisma.defectItem.findFirst({
      where: { id: defectItemId, AND: [scope.defectItemWhere()] },
      select: { id: true, actId: true },
    });
    if (!defect) throw new NotFoundException('Запись не найдена');
    return { type: 'DEFECT_ITEM', defectItemId: defect.id, actId: defect.actId };
  }

  private async requireVisibleProposal(
    user: AuthenticatedUser,
    proposalId: string,
  ): Promise<AttachmentOwnerRef> {
    const scope = new RegistryAccessScope(user);
    const proposal = await this.prisma.proposal.findFirst({
      where: { id: proposalId, defectItem: scope.defectItemWhere() },
      select: { id: true, slot: true, defectItemId: true, defectItem: { select: { actId: true } } },
    });
    if (!proposal) throw new NotFoundException('Запись не найдена');
    const owner: AttachmentOwnerRef = {
      type: 'PROPOSAL',
      proposalId: proposal.id,
      defectItemId: proposal.defectItemId,
      actId: proposal.defectItem.actId,
      slot: proposal.slot,
    };
    const assigned = await this.assignedDefectIds(user, owner.actId);
    if (!canViewAttachmentOwner(user.role, owner, assigned)) {
      throw new NotFoundException('Запись не найдена');
    }
    return owner;
  }

  private async assignedDefectIds(user: AuthenticatedUser, actId?: string): Promise<Set<string>> {
    if (user.role !== 'RESPONSIBLE_ENGINEER') {
      return new Set();
    }
    const rows = await this.prisma.defectItemEngineer.findMany({
      where: {
        userId: user.id,
        ...(actId ? { defectItem: { actId } } : {}),
      },
      select: { defectItemId: true },
    });
    return new Set(rows.map((row) => row.defectItemId));
  }

  private async limits() {
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    return {
      maxBytes:
        settings?.maxAttachmentBytes ?? loadConfig().ATTACHMENT_MAX_BYTES ?? ATTACHMENT_MAX_BYTES,
      maxPerOwner:
        settings?.maxAttachmentsPerOwner ??
        loadConfig().ATTACHMENT_MAX_PER_OWNER ??
        ATTACHMENT_MAX_PER_OWNER,
    };
  }
}

function ownerWhere(owner: AttachmentOwnerRef): Prisma.AttachmentWhereInput {
  if (owner.type === 'ACT') return { actId: owner.actId };
  if (owner.type === 'DEFECT_ITEM') return { defectItemId: owner.defectItemId };
  return { proposalId: owner.proposalId };
}

function ownerIds(owner: AttachmentOwnerRef) {
  if (owner.type === 'ACT') return { actId: owner.actId };
  if (owner.type === 'DEFECT_ITEM') return { defectItemId: owner.defectItemId };
  return { proposalId: owner.proposalId };
}

function ownerId(owner: AttachmentOwnerRef): string {
  if (owner.type === 'ACT') return owner.actId;
  if (owner.type === 'DEFECT_ITEM') return owner.defectItemId;
  return owner.proposalId;
}

export { ATTACHMENT_QUEUE, ATTACHMENT_SCAN_JOB } from './attachment.constants';
