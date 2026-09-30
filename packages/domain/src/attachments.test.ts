import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentOwnerXorError,
  AttachmentTooLargeError,
  assertAllowedFile,
  assertCategoryMatchesOwner,
  assertOwnerXor,
  assertOwnedObjectKey,
  assertSafeFilename,
  assertSafeImageDimensions,
  buildContentDisposition,
  canArchiveAttachment,
  canDownloadAttachment,
  canPreviewAttachment,
  canUploadCategory,
  canViewAttachmentOwner,
  categoriesForOwner,
  createAttachmentObjectKey,
  detectMimeFromMagic,
  extensionOf,
  isScanTerminal,
  nextScanStatus,
  normalizeAttachmentFilename,
  scanRetryDelayMs,
  sha256Hex,
  shapeAttachmentAuditForRole,
  shouldFailScan,
  shouldKeepPolling,
  attachmentHistoryVisible,
} from './attachments';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PDF = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const assigned = new Set(['defect-1']);

describe('attachment owner XOR', () => {
  it('requires exactly one owner', () => {
    expect(() => assertOwnerXor({})).toThrow(AttachmentOwnerXorError);
    expect(() => assertOwnerXor({ actId: 'a', defectItemId: 'd' })).toThrow(
      AttachmentOwnerXorError,
    );
    expect(() => assertOwnerXor({ actId: 'a' })).not.toThrow();
    expect(() => assertOwnerXor({ proposalId: 'p' })).not.toThrow();
  });
});

describe('category and owner compatibility', () => {
  it('rejects incompatible categories', () => {
    expect(categoriesForOwner('PROPOSAL')).toEqual(['PROPOSAL_DOCUMENT']);
    expect(() => assertCategoryMatchesOwner('ACT', 'PROPOSAL_DOCUMENT')).toThrow();
    expect(() => assertCategoryMatchesOwner('DEFECT_ITEM', 'DEFECT_PHOTO')).not.toThrow();
  });
});

describe('attachment permission matrix', () => {
  it('maps upload rights by role', () => {
    expect(canUploadCategory('ADMIN', 'ACT', 'ACT_DOCUMENT')).toBe(true);
    expect(canUploadCategory('SGR_MANAGER', 'DEFECT_ITEM', 'DEFECT_PHOTO')).toBe(true);
    expect(canUploadCategory('CONTRACTOR_ENGINEER', 'DEFECT_ITEM', 'THIRD_PARTY_DOCUMENT')).toBe(
      true,
    );
    expect(canUploadCategory('CONTRACTOR_ENGINEER', 'ACT', 'ACT_DOCUMENT')).toBe(false);
    expect(canUploadCategory('RESPONSIBLE_ENGINEER', 'ACT', 'ACT_DOCUMENT')).toBe(true);
    expect(canUploadCategory('RESPONSIBLE_ENGINEER', 'PROPOSAL', 'PROPOSAL_DOCUMENT')).toBe(false);
    expect(canUploadCategory('RESPONSIBLE_ENGINEER', 'DEFECT_ITEM', 'DEFECT_PHOTO')).toBe(true);
    expect(canUploadCategory('RESPONSIBLE_ENGINEER', 'DEFECT_ITEM', 'THIRD_PARTY_DOCUMENT')).toBe(
      false,
    );
    expect(canUploadCategory('SUPER_ADMIN', 'ACT', 'ACT_DOCUMENT')).toBe(false);
    expect(canUploadCategory('SUPER_ADMIN', 'PROPOSAL', 'PROPOSAL_DOCUMENT')).toBe(false);
    expect(canUploadCategory('PENDING_ROLE', 'DEFECT_ITEM', 'DEFECT_PHOTO')).toBe(false);
  });
});

describe('RESPONSIBLE attachment scope', () => {
  it('hides foreign defect and proposal B/C', () => {
    expect(
      canViewAttachmentOwner(
        'RESPONSIBLE_ENGINEER',
        { type: 'DEFECT_ITEM', defectItemId: 'defect-1', actId: 'act-1' },
        assigned,
      ),
    ).toBe(true);
    expect(
      canViewAttachmentOwner(
        'RESPONSIBLE_ENGINEER',
        { type: 'DEFECT_ITEM', defectItemId: 'other', actId: 'act-1' },
        assigned,
      ),
    ).toBe(false);
    expect(
      canViewAttachmentOwner(
        'RESPONSIBLE_ENGINEER',
        {
          type: 'PROPOSAL',
          proposalId: 'p-a',
          defectItemId: 'defect-1',
          actId: 'act-1',
          slot: 'A',
        },
        assigned,
      ),
    ).toBe(true);
    expect(
      canViewAttachmentOwner(
        'RESPONSIBLE_ENGINEER',
        {
          type: 'PROPOSAL',
          proposalId: 'p-b',
          defectItemId: 'defect-1',
          actId: 'act-1',
          slot: 'B',
        },
        assigned,
      ),
    ).toBe(false);
    expect(
      attachmentHistoryVisible({
        role: 'RESPONSIBLE_ENGINEER',
        assignedDefectItemIds: assigned,
        owner: {
          type: 'PROPOSAL',
          proposalId: 'p-c',
          defectItemId: 'defect-1',
          actId: 'act-1',
          slot: 'C',
        },
      }),
    ).toBe(false);
  });
});

describe('filename and content policy', () => {
  it('normalizes, strips CR/LF and path separators', () => {
    expect(normalizeAttachmentFilename('  фото\r\n/../a.pdf  ')).toBe('фото_.._a.pdf');
    expect(() => assertSafeFilename('photo.jpg.exe')).toThrow(/Двойное расширение/);
    expect(() => assertSafeFilename('..\\secret.pdf')).toThrow(/путь/);
    expect(extensionOf('scan.PDF')).toBe('.pdf');
  });

  it('validates magic, MIME, size and unknown types', () => {
    expect(detectMimeFromMagic(PNG)).toBe('image/png');
    expect(
      assertAllowedFile({
        filename: 'a.png',
        declaredMimeType: 'image/png',
        magic: PNG,
        sizeBytes: 128,
      }).detectedMimeType,
    ).toBe('image/png');
    expect(() =>
      assertAllowedFile({
        filename: 'a.png',
        declaredMimeType: 'image/png',
        magic: PNG,
        sizeBytes: 0,
      }),
    ).toThrow(/Пустой/);
    expect(() =>
      assertAllowedFile({
        filename: 'a.png',
        declaredMimeType: 'image/png',
        magic: PNG,
        sizeBytes: ATTACHMENT_MAX_BYTES + 1,
      }),
    ).toThrow(AttachmentTooLargeError);
    expect(() =>
      assertAllowedFile({
        filename: 'a.svg',
        declaredMimeType: 'image/svg+xml',
        magic: Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')),
        sizeBytes: 40,
      }),
    ).toThrow();
    expect(() =>
      assertAllowedFile({
        filename: 'a.png',
        declaredMimeType: 'image/png',
        magic: Uint8Array.from(Buffer.from('<html><body>x</body></html>')),
        sizeBytes: 40,
      }),
    ).toThrow();
    expect(() =>
      assertAllowedFile({
        filename: 'a.jpg',
        declaredMimeType: 'image/jpeg',
        magic: PDF,
        sizeBytes: 40,
      }),
    ).toThrow(/не совпадает/);
    expect(() =>
      assertAllowedFile({
        filename: 'a.bin',
        declaredMimeType: 'application/octet-stream',
        magic: Uint8Array.from([1, 2, 3, 4, 5]),
        sizeBytes: 5,
      }),
    ).toThrow();
  });
});

describe('object keys and checksum', () => {
  it('never uses the original filename as a key', () => {
    const id = randomUUID();
    const key = createAttachmentObjectKey(id);
    expect(key).toBe(`attachments/${id}`);
    expect(key.includes('photo')).toBe(false);
    expect(() => assertOwnedObjectKey(key, id)).not.toThrow();
    const previousEnv = process.env.NODE_ENV;
    const previousRun = process.env.SGR_TEST_RUN_ID;
    process.env.NODE_ENV = 'test';
    process.env.SGR_TEST_RUN_ID = 'run-11111111-1111-4111-8111-111111111111';
    expect(createAttachmentObjectKey(id)).toBe(
      `runs/${process.env.SGR_TEST_RUN_ID}/attachments/${id}`,
    );
    if (previousEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousEnv;
    }
    if (previousRun === undefined) {
      delete process.env.SGR_TEST_RUN_ID;
    } else {
      process.env.SGR_TEST_RUN_ID = previousRun;
    }
    expect(() => assertOwnedObjectKey('attachments/other', id)).toThrow();
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('status, download and archive rules', () => {
  it('allows download only for READY', () => {
    expect(canDownloadAttachment('READY')).toBe(true);
    expect(canDownloadAttachment('PENDING_SCAN')).toBe(false);
    expect(canPreviewAttachment('READY', 'image/jpeg')).toBe(true);
    expect(canPreviewAttachment('READY', 'image/svg+xml')).toBe(false);
    expect(nextScanStatus('PENDING_SCAN')).toBe('SCANNING');
    expect(isScanTerminal('READY')).toBe(true);
    expect(isScanTerminal('REJECTED')).toBe(true);
    expect(shouldKeepPolling(['READY', 'PENDING_SCAN'])).toBe(true);
    expect(shouldKeepPolling(['READY', 'REJECTED'])).toBe(false);
    expect(
      canArchiveAttachment({
        role: 'CONTRACTOR_ENGINEER',
        owner: { type: 'DEFECT_ITEM', defectItemId: 'defect-1', actId: 'act-1' },
        assignedDefectItemIds: assigned,
        uploadedById: 'u1',
        actorUserId: 'u1',
        status: 'READY',
      }),
    ).toBe(true);
    expect(
      canArchiveAttachment({
        role: 'CONTRACTOR_ENGINEER',
        owner: { type: 'DEFECT_ITEM', defectItemId: 'defect-1', actId: 'act-1' },
        assignedDefectItemIds: assigned,
        uploadedById: 'u1',
        actorUserId: 'u2',
        status: 'READY',
      }),
    ).toBe(false);
  });
});

describe('headers, scan retry and audit shaping', () => {
  it('builds a header-injection-safe Content-Disposition', () => {
    const header = buildContentDisposition('отчет\n.pdf', true);
    expect(header.includes('\n')).toBe(false);
    expect(header.startsWith('inline;')).toBe(true);
    expect(header).toContain("filename*=UTF-8''");
  });

  it('uses bounded backoff and hides B/C metadata from RESPONSIBLE', () => {
    expect(scanRetryDelayMs(1)).toBe(1000);
    expect(scanRetryDelayMs(3)).toBe(4000);
    expect(shouldFailScan(3)).toBe(true);
    expect(shouldFailScan(2)).toBe(false);
    expect(
      shapeAttachmentAuditForRole(
        { slot: 'B', scanSignature: 'Eicar', objectKey: 'x' },
        'RESPONSIBLE_ENGINEER',
      ),
    ).toEqual({});
    expect(
      shapeAttachmentAuditForRole({ scanSignature: 'Eicar', objectKey: 'x' }, 'ADMIN'),
    ).toEqual({
      scanSignature: 'Eicar',
    });
  });
});

describe('image limits', () => {
  it('rejects oversized pixel counts', () => {
    expect(() => assertSafeImageDimensions(1, 1)).not.toThrow();
    expect(() => assertSafeImageDimensions(10000, 5000)).toThrow();
  });
});

describe('magic samples', () => {
  it('accepts pdf jpeg png webp prefixes', () => {
    expect(detectMimeFromMagic(PDF)).toBe('application/pdf');
    expect(detectMimeFromMagic(JPEG)).toBe('image/jpeg');
    expect(detectMimeFromMagic(WEBP)).toBe('image/webp');
  });
});
