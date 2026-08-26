import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACT_NUMBER_STRATEGY,
  ActNumberImmutableError,
  DefectItemCompletionError,
  DuplicateProposalSlotError,
  UnpConflictError,
  allocateActNumber,
  archiveUser,
  assertActNumberImmutable,
  assertPasswordPolicy,
  assertUnpAvailable,
  assertUniqueProposalSlots,
  canAddProposalSlot,
  capabilitiesForRole,
  completeDefectItem,
  computeActStatus,
  createDefectItem,
  formatOfficialActNumber,
  hasCapability,
  isPasswordPolicySatisfied,
  isValidEmail,
  linkLiableOrganizations,
  linkResponsibleEngineers,
  nextSequenceFromLastIssued,
  normalizeEmail,
  normalizeUnp,
  PasswordPolicyError,
  preserveAssignmentsOnArchive,
  roleLabel,
  usesCountPlusOneStrategy,
} from './index';

describe('DefectItem lifecycle', () => {
  it('creates a new DefectItem with status IN_PROGRESS', () => {
    const item = createDefectItem({ id: 'di-1', actId: 'act-1' });
    expect(item.status).toBe('IN_PROGRESS');
    expect(item.readyAt).toBeNull();
  });

  it('rejects completion when readyAt is missing and auto-fill is disabled', () => {
    const item = createDefectItem({ id: 'di-1', actId: 'act-1' });
    expect(() => completeDefectItem(item, { autoFillReadyAt: false })).toThrow(
      DefectItemCompletionError,
    );
  });

  it('completes a DefectItem by filling readyAt on the server when omitted', () => {
    const item = createDefectItem({ id: 'di-1', actId: 'act-1' });
    const now = new Date('2026-08-26T10:00:00.000Z');
    const completed = completeDefectItem(item, { now });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.readyAt).toEqual(now);
  });
});

describe('Act status computation', () => {
  it('keeps Act IN_PROGRESS when at least one active DefectItem is unfinished', () => {
    const status = computeActStatus([
      { status: 'COMPLETED', active: true },
      { status: 'IN_PROGRESS', active: true },
    ]);
    expect(status).toBe('IN_PROGRESS');
  });

  it('marks Act COMPLETED when every active DefectItem is completed', () => {
    const status = computeActStatus([
      { status: 'COMPLETED', active: true },
      { status: 'COMPLETED', active: true },
    ]);
    expect(status).toBe('COMPLETED');
  });

  it('ignores inactive DefectItems when computing Act status', () => {
    const status = computeActStatus([
      { status: 'COMPLETED', active: true },
      { status: 'IN_PROGRESS', active: false },
    ]);
    expect(status).toBe('COMPLETED');
  });
});

describe('Proposal slots', () => {
  it('allows unique A/B/C slots on one DefectItem', () => {
    expect(() =>
      assertUniqueProposalSlots([
        { defectItemId: 'di-1', slot: 'A' },
        { defectItemId: 'di-1', slot: 'B' },
        { defectItemId: 'di-1', slot: 'C' },
      ]),
    ).not.toThrow();
  });

  it('rejects a duplicate slot inside one DefectItem', () => {
    expect(() =>
      assertUniqueProposalSlots([
        { defectItemId: 'di-1', slot: 'A' },
        { defectItemId: 'di-1', slot: 'A' },
      ]),
    ).toThrow(DuplicateProposalSlotError);
  });

  it('allows the same slot on different DefectItems', () => {
    expect(
      canAddProposalSlot([{ defectItemId: 'di-1', slot: 'A' }], {
        defectItemId: 'di-2',
        slot: 'A',
      }),
    ).toBe(true);
  });
});

describe('User archiving', () => {
  it('archives a user without destroying historical assignments', () => {
    const user = { id: 'user-1', status: 'ACTIVE' as const, archivedAt: null };
    const assignments = [
      { userId: 'user-1', assignedAt: new Date('2026-01-01T00:00:00.000Z'), unassignedAt: null },
    ];

    const archived = archiveUser(user, new Date('2026-08-26T00:00:00.000Z'));
    const preserved = preserveAssignmentsOnArchive(archived, assignments);

    expect(archived.status).toBe('ARCHIVED');
    expect(archived.archivedAt).toEqual(new Date('2026-08-26T00:00:00.000Z'));
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.userId).toBe('user-1');
    expect(preserved[0]?.unassignedAt).toBeNull();
  });
});

describe('UNP normalization and uniqueness', () => {
  it('does not treat empty UNP values as uniqueness conflicts', () => {
    expect(assertUnpAvailable(null, [null, '', '   '])).toBeNull();
    expect(assertUnpAvailable('  ', [null])).toBeNull();
    expect(normalizeUnp('')).toBeNull();
  });

  it('blocks the same non-empty normalized UNP', () => {
    expect(() => assertUnpAvailable('100 000 001', ['100000001'])).toThrow(UnpConflictError);
  });
});

describe('Act number generation', () => {
  it('formats official numbers as С-1/С-23 with a per-year sequence', () => {
    expect(formatOfficialActNumber('S1', 2026, 1)).toBe('С-1-2026-000001');
    expect(formatOfficialActNumber('S23', 2026, 12)).toBe('С-23-2026-000012');
  });

  it('forbids changing an official number after creation', () => {
    expect(() => assertActNumberImmutable('С-1-2026-000001', 'С-1-2026-000002')).toThrow(
      ActNumberImmutableError,
    );
    expect(() => assertActNumberImmutable('С-1-2026-000001', 'С-1-2026-000001')).not.toThrow();
  });

  it('allocates numbers from a stored sequence instead of count + 1', () => {
    expect(ACT_NUMBER_STRATEGY).toBe('per-form-year-sequence-table');
    expect(usesCountPlusOneStrategy()).toBe(false);
    expect(nextSequenceFromLastIssued(null)).toBe(1);
    expect(nextSequenceFromLastIssued(4)).toBe(5);

    const first = allocateActNumber({ formCode: 'S1', year: 2026, lastIssued: null });
    const second = allocateActNumber({ formCode: 'S1', year: 2026, lastIssued: 1 });
    expect(first.officialNumber).toBe('С-1-2026-000001');
    expect(second.officialNumber).toBe('С-1-2026-000002');
    expect(second.sequence).not.toBe(2 + 1);

    const source = readFileSync(resolve(__dirname, 'act-number.ts'), 'utf8');
    expect(source).not.toMatch(/count\s*\+\s*1/);
    expect(source).not.toMatch(/\.length\s*\+\s*1/);
    expect(source).toMatch(/lastIssued/);
  });
});

describe('DefectItem relationships', () => {
  it('allows several responsible engineers on one defect', () => {
    const links = linkResponsibleEngineers('di-1', ['eng-1', 'eng-2']);
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.userId)).toEqual(['eng-1', 'eng-2']);
  });

  it('allows several liable organizations on one defect', () => {
    const links = linkLiableOrganizations('di-1', ['org-1', 'org-2', 'org-3']);
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.organizationId)).toEqual(['org-1', 'org-2', 'org-3']);
  });
});

describe('email normalization', () => {
  it('trims and lowercases email without changing the local mailbox otherwise', () => {
    expect(normalizeEmail('  Alexey.Viktorov@Example.SGR.Local  ')).toBe(
      'alexey.viktorov@example.sgr.local',
    );
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('user@example.sgr.local')).toBe(true);
  });
});

describe('password policy', () => {
  it('accepts a sufficiently complex password and rejects short or overlong values', () => {
    expect(isPasswordPolicySatisfied('Dana-SGR-Demo-2026!')).toBe(true);
    expect(isPasswordPolicySatisfied('short1A!')).toBe(false);
    expect(isPasswordPolicySatisfied(`${'Aa1!'.repeat(33)}`)).toBe(false);
    expect(() => assertPasswordPolicy('nouppercase1!')).toThrow(PasswordPolicyError);
  });

  it('does not silently trim leading or trailing spaces', () => {
    const withSpaces = '  Dana-SGR-Demo-2026!  ';
    expect(withSpaces.startsWith(' ')).toBe(true);
    expect(isPasswordPolicySatisfied(withSpaces)).toBe(true);
    expect(withSpaces.length).toBeGreaterThan(12);
  });
});

describe('capabilities', () => {
  it('maps each role to the expected product capabilities', () => {
    expect(capabilitiesForRole('ADMIN')).toEqual([
      'MANAGE_USERS',
      'MANAGE_DIRECTORIES',
      'VIEW_ALL_ACTS',
      'CREATE_ACT',
      'CANCEL_ACT',
      'VIEW_AUDIT',
    ]);
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('ASSIGN_ENGINEERS');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).toEqual([
      'VIEW_ASSIGNED_DEFECTS',
      'EDIT_ASSIGNED_DEFECTS',
      'COMPLETE_ASSIGNED_DEFECTS',
      'VIEW_PROPOSAL_A',
    ]);
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).toContain('MANAGE_ORGANIZATIONS');
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_ALL_ACTS')).toBe(false);
    expect(roleLabel('ADMIN')).toBe('Администратор');
  });
});
