import { createHash, randomUUID } from 'node:crypto';
import type { UserRole } from '@sgr-registry/contracts';
import type {
  AttachmentCategory,
  AttachmentOwnerType,
  AttachmentStatus,
  ProposalSlot,
} from '@sgr-registry/contracts';
import { DomainError, ValidationError } from './errors';
import { hasCapability, type Capability } from './capabilities';
import { canViewProposalGroupBC } from './registry-access';

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_OWNER = 50;
export const ATTACHMENT_MAX_PIXELS = 40_000_000;
export const ATTACHMENT_SCAN_MAX_ATTEMPTS = 3;
export const ATTACHMENT_POLL_STATUSES: readonly AttachmentStatus[] = ['PENDING_SCAN', 'SCANNING'];
export const ATTACHMENT_TERMINAL_STATUSES: readonly AttachmentStatus[] = [
  'READY',
  'REJECTED',
  'SCAN_FAILED',
  'ARCHIVED',
];
export const ATTACHMENT_ACTIVE_STATUSES: readonly AttachmentStatus[] = [
  'UPLOADING',
  'PENDING_SCAN',
  'SCANNING',
  'READY',
  'SCAN_FAILED',
];
export const ATTACHMENT_DUPLICATE_STATUSES: readonly AttachmentStatus[] = [
  'PENDING_SCAN',
  'SCANNING',
  'READY',
  'SCAN_FAILED',
];

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const ALLOWED_ATTACHMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'] as const;

const CATEGORY_BY_OWNER: Record<AttachmentOwnerType, readonly AttachmentCategory[]> = {
  ACT: ['ACT_DOCUMENT', 'ACT_SCAN', 'OTHER'],
  DEFECT_ITEM: ['DEFECT_PHOTO', 'CLAIM_DOCUMENT', 'THIRD_PARTY_DOCUMENT', 'OTHER'],
  PROPOSAL: ['PROPOSAL_DOCUMENT'],
};

const MIME_BY_EXTENSION: Record<string, (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number]> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export class AttachmentPolicyError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'AttachmentPolicyError';
  }
}

export class AttachmentTooLargeError extends DomainError {
  constructor() {
    super('PAYLOAD_TOO_LARGE', 'Размер файла не должен превышать 20 МиБ');
    this.name = 'AttachmentTooLargeError';
  }
}

export class AttachmentOwnerXorError extends DomainError {
  constructor() {
    super('ATTACHMENT_OWNER_XOR', 'Вложение должно принадлежать ровно одному владельцу');
    this.name = 'AttachmentOwnerXorError';
  }
}

export type AttachmentOwnerRef =
  | { type: 'ACT'; actId: string }
  | { type: 'DEFECT_ITEM'; defectItemId: string; actId: string }
  | {
      type: 'PROPOSAL';
      proposalId: string;
      defectItemId: string;
      actId: string;
      slot: ProposalSlot;
    };

export function ownerFilledCount(input: {
  actId?: string | null;
  defectItemId?: string | null;
  proposalId?: string | null;
}): number {
  return [input.actId, input.defectItemId, input.proposalId].filter(
    (value) => typeof value === 'string' && value.length > 0,
  ).length;
}

export function assertOwnerXor(input: {
  actId?: string | null;
  defectItemId?: string | null;
  proposalId?: string | null;
}): void {
  if (ownerFilledCount(input) !== 1) {
    throw new AttachmentOwnerXorError();
  }
}

export function categoriesForOwner(ownerType: AttachmentOwnerType): readonly AttachmentCategory[] {
  return CATEGORY_BY_OWNER[ownerType];
}

export function assertCategoryMatchesOwner(
  ownerType: AttachmentOwnerType,
  category: AttachmentCategory,
): void {
  if (!CATEGORY_BY_OWNER[ownerType].includes(category)) {
    throw new ValidationError('category', 'Категория не совместима с владельцем вложения');
  }
}

export function canUploadCategory(
  role: UserRole,
  ownerType: AttachmentOwnerType,
  category: AttachmentCategory,
): boolean {
  if (!CATEGORY_BY_OWNER[ownerType].includes(category)) {
    return false;
  }
  if (ownerType === 'ACT') {
    return hasCapability(role, 'UPLOAD_ACT_ATTACHMENT');
  }
  if (ownerType === 'PROPOSAL') {
    return hasCapability(role, 'UPLOAD_PROPOSAL_ATTACHMENT') && category === 'PROPOSAL_DOCUMENT';
  }
  if (role === 'CONTRACTOR_ENGINEER') {
    return category === 'THIRD_PARTY_DOCUMENT';
  }
  if (role === 'RESPONSIBLE_ENGINEER') {
    return category === 'DEFECT_PHOTO' || category === 'OTHER';
  }
  return hasCapability(role, 'UPLOAD_DEFECT_ATTACHMENT');
}

export function canViewAttachmentOwner(
  role: UserRole,
  owner: AttachmentOwnerRef,
  assignedDefectItemIds: ReadonlySet<string>,
): boolean {
  if (role !== 'RESPONSIBLE_ENGINEER') {
    if (owner.type === 'PROPOSAL' && (owner.slot === 'B' || owner.slot === 'C')) {
      return canViewProposalGroupBC(role);
    }
    return true;
  }
  if (owner.type === 'ACT') {
    return assignedDefectItemIds.size > 0;
  }
  if (owner.type === 'DEFECT_ITEM') {
    return assignedDefectItemIds.has(owner.defectItemId);
  }
  if (owner.slot !== 'A') {
    return false;
  }
  return assignedDefectItemIds.has(owner.defectItemId);
}

export function canArchiveAttachment(input: {
  role: UserRole;
  owner: AttachmentOwnerRef;
  assignedDefectItemIds: ReadonlySet<string>;
  uploadedById: string;
  actorUserId: string;
  status: AttachmentStatus;
}): boolean {
  if (input.status === 'ARCHIVED' || input.status === 'UPLOADING') {
    return false;
  }
  if (!canViewAttachmentOwner(input.role, input.owner, input.assignedDefectItemIds)) {
    return false;
  }
  if (!hasCapability(input.role, 'ARCHIVE_ATTACHMENT')) {
    return false;
  }
  if (input.role === 'ADMIN' || input.role === 'SGR_MANAGER') {
    return true;
  }
  return input.uploadedById === input.actorUserId;
}

export function canDownloadAttachment(status: AttachmentStatus): boolean {
  return status === 'READY';
}

export function canPreviewAttachment(status: AttachmentStatus, mimeType: string | null): boolean {
  if (status !== 'READY' || !mimeType) {
    return false;
  }
  return (
    mimeType === 'application/pdf' ||
    mimeType === 'image/jpeg' ||
    mimeType === 'image/png' ||
    mimeType === 'image/webp'
  );
}

export function shouldKeepPolling(statuses: readonly AttachmentStatus[]): boolean {
  return statuses.some((status) => ATTACHMENT_POLL_STATUSES.includes(status));
}

export function nextScanStatus(current: AttachmentStatus): AttachmentStatus | null {
  if (current === 'PENDING_SCAN' || current === 'SCANNING') {
    return 'SCANNING';
  }
  return null;
}

export function isScanTerminal(status: AttachmentStatus): boolean {
  return status === 'READY' || status === 'REJECTED' || status === 'ARCHIVED';
}

export function scanRetryDelayMs(attempt: number): number {
  const bounded = Math.max(1, Math.min(attempt, ATTACHMENT_SCAN_MAX_ATTEMPTS));
  return 2 ** (bounded - 1) * 1000;
}

export function shouldFailScan(attempts: number): boolean {
  return attempts >= ATTACHMENT_SCAN_MAX_ATTEMPTS;
}

export function normalizeAttachmentFilename(raw: string): string {
  const normalized = [...raw.normalize('NFC')]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  const trimmed = normalized.replace(/[\\/]/g, '_').trim();
  const cut = trimmed.slice(0, 180);
  return cut.length > 0 ? cut : 'attachment';
}

export function assertSafeFilename(raw: string): string {
  const safe = normalizeAttachmentFilename(raw);
  if (safe.includes('\r') || safe.includes('\n')) {
    throw new AttachmentPolicyError('UNSAFE_FILENAME', 'Имя файла содержит недопустимые символы');
  }
  const lower = safe.toLowerCase();
  if (lower.includes('..')) {
    throw new AttachmentPolicyError('UNSAFE_FILENAME', 'Имя файла содержит недопустимый путь');
  }
  const parts = lower.split('.');
  if (parts.length > 2) {
    throw new AttachmentPolicyError('UNSAFE_FILENAME', 'Двойное расширение файла запрещено');
  }
  return safe;
}

export function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? '';
}

export function detectMimeFromMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 4) {
    return null;
  }
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    looksLikeSvgOrHtml(bytes) ||
    looksLikeXml(bytes) ||
    looksLikeZip(bytes) ||
    looksLikeExecutable(bytes)
  ) {
    return 'application/octet-stream';
  }
  return null;
}

function asciiPrefix(bytes: Uint8Array, length = 64): string {
  return Buffer.from(bytes.subarray(0, Math.min(bytes.length, length)))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
}

function looksLikeSvgOrHtml(bytes: Uint8Array): boolean {
  const text = asciiPrefix(bytes);
  return (
    text.startsWith('<svg') ||
    text.startsWith('<!doctype html') ||
    text.startsWith('<html') ||
    text.includes('<svg')
  );
}

function looksLikeXml(bytes: Uint8Array): boolean {
  const text = asciiPrefix(bytes);
  return text.startsWith('<?xml') && !text.includes('<svg');
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function looksLikeExecutable(bytes: Uint8Array): boolean {
  return bytes[0] === 0x4d && bytes[1] === 0x5a;
}

export function assertAllowedFile(input: {
  filename: string;
  declaredMimeType: string;
  magic: Uint8Array;
  sizeBytes: number;
}): { detectedMimeType: (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number]; safeDisplayName: string } {
  if (input.sizeBytes <= 0) {
    throw new AttachmentPolicyError('EMPTY_FILE', 'Пустой файл загружать нельзя');
  }
  if (input.sizeBytes > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentTooLargeError();
  }
  const safeDisplayName = assertSafeFilename(input.filename);
  const extension = extensionOf(safeDisplayName);
  if (
    !ALLOWED_ATTACHMENT_EXTENSIONS.includes(
      extension as (typeof ALLOWED_ATTACHMENT_EXTENSIONS)[number],
    )
  ) {
    throw new AttachmentPolicyError('UNSUPPORTED_TYPE', 'Допустимы только PDF, JPEG, PNG и WebP');
  }
  const expectedMime = MIME_BY_EXTENSION[extension];
  const declared = input.declaredMimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (declared && declared !== expectedMime && declared !== 'application/octet-stream') {
    throw new AttachmentPolicyError(
      'MIME_MISMATCH',
      'Заявленный тип файла не совпадает с расширением',
    );
  }
  const detected = detectMimeFromMagic(input.magic);
  if (
    !detected ||
    !ALLOWED_ATTACHMENT_MIME_TYPES.includes(
      detected as (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number],
    )
  ) {
    throw new AttachmentPolicyError(
      'UNSUPPORTED_TYPE',
      'Содержимое файла не относится к допустимым форматам',
    );
  }
  if (detected !== expectedMime) {
    throw new AttachmentPolicyError('MIME_MISMATCH', 'Содержимое файла не совпадает с расширением');
  }
  return { detectedMimeType: detected, safeDisplayName };
}

export function assertSafeImageDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AttachmentPolicyError('UNSAFE_IMAGE', 'Некорректные размеры изображения');
  }
  if (width * height > ATTACHMENT_MAX_PIXELS) {
    throw new AttachmentPolicyError(
      'UNSAFE_IMAGE',
      'Изображение превышает допустимое число пикселей',
    );
  }
}

export function createAttachmentObjectKey(id: string = randomUUID()): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AttachmentPolicyError('UNSAFE_OBJECT_KEY', 'Некорректный идентификатор объекта');
  }
  return `attachments/${id}`;
}

export function assertOwnedObjectKey(objectKey: string, attachmentId: string): void {
  if (objectKey !== `attachments/${attachmentId}`) {
    throw new AttachmentPolicyError('UNSAFE_OBJECT_KEY', 'Ключ объекта не принадлежит вложению');
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildContentDisposition(filename: string, inline: boolean): string {
  const safe = normalizeAttachmentFilename(filename).replace(/["\\]/g, '_');
  const ascii = safe.replace(/[^\x20-\x7E]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(safe);
  const type = inline ? 'inline' : 'attachment';
  const header = `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  if (header.includes('\r') || header.includes('\n')) {
    throw new AttachmentPolicyError('UNSAFE_FILENAME', 'Имя файла нельзя подставить в заголовок');
  }
  return header;
}

export function attachmentHistoryVisible(input: {
  role: UserRole;
  assignedDefectItemIds: ReadonlySet<string>;
  owner: AttachmentOwnerRef;
}): boolean {
  return canViewAttachmentOwner(input.role, input.owner, input.assignedDefectItemIds);
}

export function shapeAttachmentAuditForRole(value: unknown, role: UserRole): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  delete record.objectKey;
  delete record.bucket;
  delete record.scanTrace;
  delete record.rawScannerResponse;
  if (role !== 'ADMIN' && role !== 'SGR_MANAGER') {
    delete record.scanSignature;
  }
  if (role === 'RESPONSIBLE_ENGINEER' && (record.slot === 'B' || record.slot === 'C')) {
    return {};
  }
  return record;
}

export const ATTACHMENT_AUDIT_ACTIONS = [
  'ATTACHMENT_UPLOADED',
  'ATTACHMENT_SCAN_STARTED',
  'ATTACHMENT_SCAN_PASSED',
  'ATTACHMENT_REJECTED',
  'ATTACHMENT_SCAN_FAILED',
  'ATTACHMENT_ARCHIVED',
] as const;

export type AttachmentAuditAction = (typeof ATTACHMENT_AUDIT_ACTIONS)[number];

export const ATTACHMENT_UPLOAD_CAPABILITIES: Record<AttachmentOwnerType, Capability> = {
  ACT: 'UPLOAD_ACT_ATTACHMENT',
  DEFECT_ITEM: 'UPLOAD_DEFECT_ATTACHMENT',
  PROPOSAL: 'UPLOAD_PROPOSAL_ATTACHMENT',
};
