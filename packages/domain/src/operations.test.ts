import { describe, expect, it } from 'vitest';
import {
  adminGrantRequestSchema,
  createActRequestSchema,
  createUnassignedUserRequestSchema,
  createUserRequestSchema,
  patchActHeaderRequestSchema,
  patchDeadlinesRequestSchema,
  upsertProposalRequestSchema,
} from '@sgr-registry/contracts';
import {
  assertAuditPayloadSafe,
  assertCaseInsensitiveUnique,
  assertLastActiveAdminProtected,
  assertCanGrantAdmin,
  assertCanRevokeAdmin,
  nextAdminGrantState,
  previousRoleAfterAdminRevoke,
  AdminGrantNotEligibleError,
  LastAdminRevokeError,
  SelfAdminGrantError,
  assertNotSelfArchive,
  assertUniqueIds,
  calendarDateToUtcNoon,
  canAddProposalSlot,
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
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'CREATE_ACT')).toBe(true);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'EDIT_ACT_HEADER')).toBe(true);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'MANAGE_PROPOSALS')).toBe(false);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_REFERENCE_DATA')).toBe(true);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'MANAGE_REFERENCE_DATA')).toBe(false);
    expect(hasCapability('CONTRACTOR_ENGINEER', 'COMPLETE_DEFECT')).toBe(false);
    expect(hasCapability('CONTRACTOR_ENGINEER', 'VIEW_HISTORY')).toBe(false);
    expect(hasCapability('CONTRACTOR_ENGINEER', 'VIEW_ASSIGNED_HISTORY')).toBe(false);
    expect(hasCapability('ADMIN', 'VIEW_HISTORY')).toBe(true);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_ASSIGNED_HISTORY')).toBe(true);
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

  it('keeps SUPER_ADMIN admin-grant rules deny-by-default', () => {
    const manager = {
      id: 'm1',
      role: 'SGR_MANAGER' as const,
      status: 'ACTIVE' as const,
      archivedAt: null,
      roleBeforeAdmin: null,
    };
    assertCanGrantAdmin({ actorId: 'sa', target: manager });
    expect(nextAdminGrantState(manager)).toEqual({
      role: 'ADMIN',
      roleBeforeAdmin: 'SGR_MANAGER',
    });
    const responsible = { ...manager, id: 'r1', role: 'RESPONSIBLE_ENGINEER' as const };
    expect(nextAdminGrantState(responsible).roleBeforeAdmin).toBe('RESPONSIBLE_ENGINEER');
    expect(nextAdminGrantState({ ...manager, role: 'CONTRACTOR_ENGINEER' })).toEqual({
      role: 'ADMIN',
      roleBeforeAdmin: 'CONTRACTOR_ENGINEER',
    });
    expect(nextAdminGrantState({ ...manager, role: 'PENDING_ROLE' })).toEqual({
      role: 'ADMIN',
      roleBeforeAdmin: 'UNASSIGNED',
    });
    expect(() =>
      assertCanGrantAdmin({
        actorId: 'sa',
        target: { ...manager, role: 'SUPER_ADMIN' },
      }),
    ).toThrow(AdminGrantNotEligibleError);
    expect(() => assertCanGrantAdmin({ actorId: 'm1', target: manager })).toThrow(
      SelfAdminGrantError,
    );
    const admin = {
      id: 'a1',
      role: 'ADMIN' as const,
      status: 'ACTIVE' as const,
      archivedAt: null,
      roleBeforeAdmin: 'RESPONSIBLE_ENGINEER' as const,
    };
    assertCanGrantAdmin({ actorId: 'sa', target: admin });
    expect(previousRoleAfterAdminRevoke(admin)).toBe('RESPONSIBLE_ENGINEER');
    expect(previousRoleAfterAdminRevoke({ role: 'ADMIN', roleBeforeAdmin: null })).toBe(
      'PENDING_ROLE',
    );
    expect(previousRoleAfterAdminRevoke({ role: 'ADMIN', roleBeforeAdmin: 'UNASSIGNED' })).toBe(
      'PENDING_ROLE',
    );
    expect(() =>
      assertCanRevokeAdmin({ actorId: 'sa', target: admin, activeAdminCount: 1 }),
    ).toThrow(LastAdminRevokeError);
    assertCanRevokeAdmin({ actorId: 'sa', target: admin, activeAdminCount: 2 });
    expect(adminGrantRequestSchema.safeParse({ expectedVersion: 1, role: 'ADMIN' }).success).toBe(
      false,
    );
    expect(
      createUserRequestSchema.safeParse({
        fullName: 'Иван Иванов',
        email: 'ivan@example.sgr.local',
        role: 'ADMIN',
      }).success,
    ).toBe(false);
    expect(
      createUserRequestSchema.safeParse({
        fullName: 'Иван Иванов',
        email: 'ivan@example.sgr.local',
        role: 'SUPER_ADMIN',
      }).success,
    ).toBe(false);
    expect(
      createUnassignedUserRequestSchema.safeParse({
        fullName: 'Иван Иванов',
        email: 'ivan@example.sgr.local',
      }).success,
    ).toBe(true);
    expect(
      createUnassignedUserRequestSchema.safeParse({
        fullName: 'Иван Иванов',
        email: 'ivan@example.sgr.local',
        role: 'ADMIN',
      }).success,
    ).toBe(false);
    expect(
      createUnassignedUserRequestSchema.safeParse({
        fullName: 'Иван Иванов',
        email: 'ivan@example.sgr.local',
        status: 'ACTIVE',
      }).success,
    ).toBe(false);
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
    const spoofed = createActRequestSchema.safeParse({
      formCode: 'S1',
      objectId: '11111111-1111-4111-8111-111111111111',
      objectName: 'Подмена',
      objectAddress: 'Чужой адрес',
      customerOrganizationId: '22222222-2222-4222-8222-222222222222',
      issuedOn: '2026-08-01',
      defectItems: [
        {
          location: 'Кв. 1',
          defectTypeId: '33333333-3333-4333-8333-333333333333',
          claimDetails: 'Течь',
          responsibleEngineerIds: ['44444444-4444-4444-8444-444444444444'],
          liableOrganizationIds: ['55555555-5555-4555-8555-555555555555'],
        },
      ],
    });
    expect(spoofed.success).toBe(false);
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
    expect(deadlineFieldsForRole('RESPONSIBLE_ENGINEER')).toEqual([
      'plannedDeadline',
      'claimDeadline',
      'thirdPartyDeadline',
    ]);
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

  it('rejects unknown organizationName on upsert', () => {
    const parsed = upsertProposalRequestSchema.safeParse({
      amount: '10.00',
      alternativeContractorOrganizationId: '11111111-1111-4111-8111-111111111111',
      organizationName: 'ООО Подмена',
    });
    expect(parsed.success).toBe(false);
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

  it('hides every history event from contractors', () => {
    const visible = historyVisibleToRole(
      {
        id: 'e3',
        action: 'DEADLINE_UPDATED',
        entityType: 'DEFECT_ITEM',
        entityId: 'd1',
        parentEntityType: 'ACT',
        parentEntityId: 'act',
        oldValue: null,
        newValue: { thirdPartyDeadline: '2026-10-01' },
        reason: null,
        actorUserId: 'u',
        actorName: 'Подрядчик',
        occurredAt: new Date(),
        requestId: null,
      },
      { role: 'CONTRACTOR_ENGINEER', assignedDefectItemIds: new Set(['d1']), actId: 'act' },
    );
    expect(visible).toBe(false);
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
