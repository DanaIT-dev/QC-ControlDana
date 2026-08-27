import { describe, expect, it } from 'vitest';
import {
  createActRequestSchema,
  patchActHeaderRequestSchema,
  patchDeadlinesRequestSchema,
} from '@sgr-registry/contracts';
import {
  assertAuditPayloadSafe,
  assertCaseInsensitiveUnique,
  assertLastActiveAdminProtected,
  assertNotSelfArchive,
  assertUniqueIds,
  calendarDateToUtcNoon,
  canAddProposalSlot,
  capabilitiesForRole,
  completeDefectItem,
  containsSensitiveAuditKey,
  deadlineChangeRequiresReason,
  deadlineFieldsForRole,
  DuplicateValueError,
  effectiveDeadlineOf,
  ForbiddenFieldError,
  foldKey,
  hasCapability,
  historyVisibleToRole,
  InvalidTransitionError,
  LastAdminProtectedError,
  normalizeEmail,
  normalizeReferenceCode,
  normalizeRequiredText,
  normalizeUserEmail,
  omitSensitiveKeys,
  parseProposalAmount,
  reopenDefectItem,
  SelfArchiveError,
  shapeHistoryForRole,
  StaleWriteError,
  ValidationError,
} from './index';

describe('permission matrix', () => {
  it('does not take capabilities from the client payload', () => {
    expect(hasCapability('ADMIN', 'MANAGE_USERS')).toBe(true);
    expect(hasCapability('SGR_MANAGER', 'MANAGE_USERS')).toBe(false);
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).not.toContain('MANAGE_PROPOSALS');
    expect(hasCapability('CONTRACTOR_ENGINEER', 'COMPLETE_DEFECT')).toBe(false);
  });
});

describe('reference validation', () => {
  it('trims, normalizes unicode and rejects empty values', () => {
    expect(normalizeRequiredText('  Кафе\u0301  ', 'name', 200)).toBe('Кафе́'.normalize('NFC'));
    expect(() => normalizeRequiredText('   ', 'name', 200)).toThrow(ValidationError);
  });

  it('detects case-insensitive duplicates', () => {
    expect(() => assertCaseInsensitiveUnique('Офис', ['офис'])).toThrow(DuplicateValueError);
    assertCaseInsensitiveUnique('Новый', ['офис']);
    expect(foldKey('  КОД  ')).toBe('код');
    expect(normalizeReferenceCode(' sewer ')).toBe('SEWER');
  });
});

describe('user lifecycle rules', () => {
  it('protects the last active admin and self-archive', () => {
    expect(() =>
      assertLastActiveAdminProtected({
        targetUserId: 'a',
        targetRole: 'ADMIN',
        nextStatus: 'ARCHIVED',
        activeAdminCount: 1,
      }),
    ).toThrow(LastAdminProtectedError);
    expect(() => assertNotSelfArchive('u1', 'u1')).toThrow(SelfArchiveError);
    assertNotSelfArchive('u1', 'u2');
  });

  it('normalizes emails without regard to case', () => {
    expect(normalizeUserEmail('  Alex@Example.SGR.local ')).toBe('alex@example.sgr.local');
    expect(normalizeEmail('A@B.C')).toBe('a@b.c');
  });
});

describe('audit secret exclusion', () => {
  it('omits password, hash, session and csrf keys', () => {
    const cleaned = omitSensitiveKeys({
      fullName: 'Иван',
      password: 'secret',
      passwordHash: 'hash',
      csrfToken: 'token',
      sessionId: 'sid',
    });
    expect(cleaned).toEqual({ fullName: 'Иван' });
    expect(containsSensitiveAuditKey({ nested: { passwordHash: 'x' } })).toBe(true);
    expect(containsSensitiveAuditKey({ mustChangePassword: true })).toBe(false);
    expect(containsSensitiveAuditKey({ passwordChangedAt: '2026-01-01' })).toBe(false);
    expect(() => assertAuditPayloadSafe({ password: 'x' })).toThrow(/Sensitive/);
    assertAuditPayloadSafe({ mustChangePassword: true, role: 'ADMIN' });
  });
});

describe('act create validation', () => {
  it('requires at least one defect item and rejects unknown fields', () => {
    const parsed = createActRequestSchema.safeParse({
      formCode: 'S1',
      objectId: '11111111-1111-4111-8111-111111111111',
      customerOrganizationId: '22222222-2222-4222-8222-222222222222',
      issuedOn: '2026-08-01',
      defectItems: [],
    });
    expect(parsed.success).toBe(false);
    const unknown = patchActHeaderRequestSchema.safeParse({
      expectedVersion: 1,
      officialNumber: 'С-1-2026-000001',
    });
    expect(unknown.success).toBe(false);
  });

  it('rejects duplicate assignment ids', () => {
    expect(() => assertUniqueIds(['a', 'a'], 'responsibleEngineerIds')).toThrow(ValidationError);
  });
});

describe('deadlines', () => {
  it('computes field rights and requires a reason on change', () => {
    expect(deadlineFieldsForRole('RESPONSIBLE_ENGINEER')).toEqual(['plannedDeadline']);
    expect(deadlineFieldsForRole('CONTRACTOR_ENGINEER')).toEqual(['thirdPartyDeadline']);
    expect(deadlineChangeRequiresReason({ previous: null, next: '2026-08-10' })).toBe(false);
    expect(deadlineChangeRequiresReason({ previous: '2026-08-10', next: '2026-08-20' })).toBe(true);
    expect(
      effectiveDeadlineOf({
        claimDeadline: calendarDateToUtcNoon('2026-09-01'),
        plannedDeadline: calendarDateToUtcNoon('2026-08-01'),
      }),
    ).toEqual(calendarDateToUtcNoon('2026-09-01'));
  });
});

describe('defect transitions', () => {
  it('allows completion and forbids invalid reopen', () => {
    const item = { id: 'd1', actId: 'a1', status: 'IN_PROGRESS' as const, readyAt: null };
    const completed = completeDefectItem(item, {
      readyAt: calendarDateToUtcNoon('2026-08-01'),
      now: calendarDateToUtcNoon('2026-08-02'),
    });
    expect(completed.status).toBe('COMPLETED');
    expect(() =>
      completeDefectItem(item, {
        readyAt: calendarDateToUtcNoon('2099-01-01'),
        now: calendarDateToUtcNoon('2026-08-02'),
      }),
    ).toThrow();
    expect(() => reopenDefectItem(completed, { reason: '' })).toThrow(InvalidTransitionError);
    expect(reopenDefectItem(completed, { reason: 'нужно доработать' }).status).toBe('IN_PROGRESS');
  });
});

describe('proposals', () => {
  it('parses decimal amounts exactly and enforces slot uniqueness', () => {
    expect(parseProposalAmount('10.5')).toBe('10.50');
    expect(() => parseProposalAmount(10 as unknown as string)).toThrow(ValidationError);
    expect(
      canAddProposalSlot([{ defectItemId: 'd', slot: 'A', status: 'ACTIVE' }], {
        defectItemId: 'd',
        slot: 'A',
        status: 'ACTIVE',
      }),
    ).toBe(false);
    expect(
      canAddProposalSlot([{ defectItemId: 'd', slot: 'A', status: 'ARCHIVED' }], {
        defectItemId: 'd',
        slot: 'A',
        status: 'ACTIVE',
      }),
    ).toBe(true);
  });
});

describe('history visibility', () => {
  it('excludes B/C events and foreign defects for responsible engineers', () => {
    const assigned = new Set(['d1']);
    const hidden = historyVisibleToRole(
      {
        id: 'e1',
        action: 'PROPOSAL_UPSERTED',
        entityType: 'PROPOSAL',
        entityId: 'p1',
        parentEntityType: 'DEFECT_ITEM',
        parentEntityId: 'd1',
        oldValue: null,
        newValue: { slot: 'B', amount: '1.00' },
        reason: null,
        actorUserId: 'u',
        actorName: 'A',
        occurredAt: new Date(),
        requestId: null,
      },
      { role: 'RESPONSIBLE_ENGINEER', assignedDefectItemIds: assigned, actId: 'act' },
    );
    expect(hidden).toBe(false);
    const shaped = shapeHistoryForRole(
      {
        id: 'e2',
        action: 'DEADLINE_UPDATED',
        entityType: 'DEFECT_ITEM',
        entityId: 'd1',
        parentEntityType: 'ACT',
        parentEntityId: 'act',
        oldValue: { proposalsBC: [{ slot: 'B' }] },
        newValue: { plannedDeadline: '2026-08-10' },
        reason: 'перенос',
        actorUserId: 'u',
        actorName: 'A',
        occurredAt: new Date(),
        requestId: null,
      },
      'RESPONSIBLE_ENGINEER',
    );
    expect(shaped.oldValue).toEqual({});
  });
});

describe('optimistic concurrency helpers', () => {
  it('exposes stale write and forbidden field errors', () => {
    expect(new StaleWriteError().code).toBe('STALE_WRITE');
    expect(new ForbiddenFieldError('claimDeadline').code).toBe('FORBIDDEN_FIELD');
    const unknown = patchDeadlinesRequestSchema.safeParse({
      expectedVersion: 1,
      deadlineState: 'OVERDUE',
    });
    expect(unknown.success).toBe(false);
  });
});
