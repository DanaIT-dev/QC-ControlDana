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
  canAccessReferenceKind,
  canViewAssignedHistory,
  canViewActChat,
  canViewFullHistory,
  canViewHistory,
  completeDefectItem,
  computeActStatus,
  createDefectItem,
  formatOfficialActNumber,
  hasCapability,
  isOversightRole,
  isPendingRole,
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
  satisfiesCapability,
  usesCountPlusOneStrategy,
  parseRegistryListQuery,
  RegistryQueryError,
  serializeRegistryQuery,
  calendarDateToUtcNoon,
  calendarDateInTimeZone,
  effectiveDeadlineOf,
  deadlineStateOf,
  serializeDecimal,
  formatProposalMoney,
  registryAccessMode,
  isObjectScopedRole,
  visibleProposalSlots,
  postLoginPath,
  canViewProposalASum,
  canViewProposalGroupBC,
  countActiveRegistryFilters,
  shapeProposals,
  shapeSummary,
  isEmptyRegistryQuery,
  filterPropertyObjects,
  propertyObjectById,
  selectablePropertyObjects,
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
  const allowed = 'treefrog';
  const context = {
    email: 'alexey.viktorov@example.sgr.local',
    fullName: 'Алексей Викторов',
  };

  it('accepts eight lowercase letters that are not blocked', () => {
    expect(isPasswordPolicySatisfied(allowed)).toBe(true);
    expect(() => assertPasswordPolicy(allowed, context)).not.toThrow();
  });

  it('accepts lowercase letters with digits and does not require uppercase or special characters', () => {
    expect(isPasswordPolicySatisfied('tree1234')).toBe(true);
    expect(isPasswordPolicySatisfied('nouppercase1!')).toBe(true);
    expect(isPasswordPolicySatisfied('тетрадка')).toBe(true);
    expect(isPasswordPolicySatisfied('TreeFrog!')).toBe(true);
    expect(isPasswordPolicySatisfied('Dana-SGR-Demo-2026!')).toBe(true);
  });

  it('rejects seven characters and 129 characters', () => {
    expect(isPasswordPolicySatisfied('abcdefg')).toBe(false);
    expect(() => assertPasswordPolicy('abcdefg')).toThrow(PasswordPolicyError);
    expect(isPasswordPolicySatisfied(`${allowed}${'xy'.repeat(60)}z`)).toBe(false);
  });

  it('rejects common passwords, identical characters, and obvious sequences', () => {
    expect(() => assertPasswordPolicy('password')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('qwertyui')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('12345678')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('admin123')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('aaaaaaaa')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('abcdefgh')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('87654321')).toThrow(PasswordPolicyError);
  });

  it('rejects a password that matches email or an obvious name part', () => {
    expect(() => assertPasswordPolicy('alexey.viktorov', context)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy(context.email, context)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('Викторов', context)).toThrow(PasswordPolicyError);
    expect(() => assertPasswordPolicy('алексей1', context)).toThrow(PasswordPolicyError);
  });

  it('rejects blank passwords and leading or trailing spaces without mutating the value', () => {
    const withSpaces = `  ${allowed}  `;
    expect(withSpaces.startsWith(' ')).toBe(true);
    expect(isPasswordPolicySatisfied(withSpaces)).toBe(false);
    expect(isPasswordPolicySatisfied('        ')).toBe(false);
    expect(isPasswordPolicySatisfied('tree frog')).toBe(true);
    expect(withSpaces).toBe(`  ${allowed}  `);
  });

  it('accepts the SUPER_ADMIN provisioning format', () => {
    expect(() =>
      assertPasswordPolicy(allowed, {
        email: 'bolutenko_p@bir.by',
        fullName: 'Суперадминистратор',
      }),
    ).not.toThrow();
  });

  it('keeps a single shared validator without class-composition rules', () => {
    const source = readFileSync(resolve(__dirname, 'password-policy.ts'), 'utf8');
    expect(source).toMatch(/PASSWORD_MIN_LENGTH = 8/);
    expect(source).not.toMatch(/!\/\[A-Z\]/);
    expect(source).not.toMatch(/!\/\\d\//);
    expect(source).not.toMatch(/!\/\[\^A-Za-z0-9\]/);
  });
});

describe('capabilities', () => {
  it('maps each role to the expected product capabilities', () => {
    expect(capabilitiesForRole('ADMIN')).toEqual([
      'MANAGE_USERS',
      'MANAGE_REFERENCE_DATA',
      'VIEW_REFERENCE_DATA',
      'VIEW_SYSTEM_STATUS',
      'VIEW_ALL_ACTS',
      'CREATE_ACT',
      'EDIT_ACT_HEADER',
      'ADD_DEFECT',
      'EDIT_ASSIGNMENTS',
      'EDIT_PLANNED_DEADLINE',
      'EDIT_CLAIM_DEADLINE',
      'EDIT_THIRD_PARTY_DEADLINE',
      'COMPLETE_DEFECT',
      'REOPEN_DEFECT',
      'MANAGE_PROPOSALS',
      'VIEW_PROPOSAL_A',
      'VIEW_HISTORY',
      'VIEW_ACT_CHAT',
      'CANCEL_ACT',
      'VIEW_ATTACHMENTS',
      'UPLOAD_ACT_ATTACHMENT',
      'UPLOAD_DEFECT_ATTACHMENT',
      'UPLOAD_PROPOSAL_ATTACHMENT',
      'ARCHIVE_ATTACHMENT',
      'DOWNLOAD_ATTACHMENT',
      'VIEW_NOTIFICATIONS',
      'VIEW_DEADLINE_CONTROL',
      'MANAGE_NOTIFICATION_SETTINGS',
      'CHANGE_OWN_PASSWORD',
      'VIEW_OWN_PROFILE',
    ]);
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('CREATE_ACT');
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('VIEW_REFERENCE_DATA');
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('VIEW_HISTORY');
    expect(capabilitiesForRole('SGR_MANAGER')).toContain('VIEW_ACT_CHAT');
    expect(capabilitiesForRole('SGR_MANAGER')).not.toContain('VIEW_ASSIGNED_HISTORY');
    expect(capabilitiesForRole('SGR_MANAGER')).not.toContain('MANAGE_USERS');
    expect(capabilitiesForRole('RESPONSIBLE_ENGINEER')).toEqual([
      'VIEW_REFERENCE_DATA',
      'VIEW_ASSIGNED_DEFECTS',
      'CREATE_ACT',
      'EDIT_ACT_HEADER',
      'ADD_DEFECT',
      'EDIT_ASSIGNMENTS',
      'EDIT_PLANNED_DEADLINE',
      'EDIT_CLAIM_DEADLINE',
      'EDIT_THIRD_PARTY_DEADLINE',
      'COMPLETE_DEFECT',
      'REOPEN_DEFECT',
      'VIEW_PROPOSAL_A',
      'VIEW_ASSIGNED_HISTORY',
      'VIEW_ACT_CHAT',
      'VIEW_ATTACHMENTS',
      'UPLOAD_ACT_ATTACHMENT',
      'UPLOAD_DEFECT_ATTACHMENT',
      'ARCHIVE_ATTACHMENT',
      'DOWNLOAD_ATTACHMENT',
      'VIEW_NOTIFICATIONS',
      'VIEW_DEADLINE_CONTROL',
      'CHANGE_OWN_PASSWORD',
      'VIEW_OWN_PROFILE',
    ]);
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).toContain('EDIT_THIRD_PARTY_DEADLINE');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('MANAGE_REFERENCE_DATA');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_REFERENCE_DATA');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_HISTORY');
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_ASSIGNED_HISTORY');
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_REFERENCE_DATA')).toBe(true);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'MANAGE_REFERENCE_DATA')).toBe(false);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'CREATE_ACT')).toBe(true);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'MANAGE_PROPOSALS')).toBe(false);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'MANAGE_REFERENCE_DATA')).toBe(false);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_ALL_ACTS')).toBe(false);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_HISTORY')).toBe(false);
    expect(hasCapability('RESPONSIBLE_ENGINEER', 'VIEW_ASSIGNED_HISTORY')).toBe(true);
    expect(canViewFullHistory('ADMIN')).toBe(true);
    expect(canViewFullHistory('SGR_MANAGER')).toBe(true);
    expect(canViewAssignedHistory('RESPONSIBLE_ENGINEER')).toBe(true);
    expect(canViewHistory('CONTRACTOR_ENGINEER')).toBe(false);
    expect(canViewActChat('ADMIN')).toBe(true);
    expect(canViewActChat('SGR_MANAGER')).toBe(true);
    expect(canViewActChat('RESPONSIBLE_ENGINEER')).toBe(true);
    expect(canViewActChat('CONTRACTOR_ENGINEER')).toBe(false);
    expect(canViewActChat('SUPER_ADMIN')).toBe(true);
    expect(hasCapability('SUPER_ADMIN', 'VIEW_ACT_CHAT')).toBe(false);
    expect(satisfiesCapability('SUPER_ADMIN', 'VIEW_ACT_CHAT')).toBe(true);
    expect(capabilitiesForRole('CONTRACTOR_ENGINEER')).not.toContain('VIEW_ACT_CHAT');
    expect(capabilitiesForRole('SUPER_ADMIN')).toEqual([
      'VIEW_ALL_BUSINESS_DATA',
      'CREATE_UNASSIGNED_USER',
      'MANAGE_ADMIN_GRANTS',
      'CHANGE_OWN_PASSWORD',
      'VIEW_OWN_PROFILE',
    ]);
    expect(capabilitiesForRole('SUPER_ADMIN')).not.toContain('MANAGE_USERS');
    expect(capabilitiesForRole('SUPER_ADMIN')).not.toContain('VIEW_ALL_ACTS');
    expect(capabilitiesForRole('SUPER_ADMIN')).not.toContain('CREATE_ACT');
    expect(capabilitiesForRole('PENDING_ROLE')).toEqual([
      'CHANGE_OWN_PASSWORD',
      'VIEW_OWN_PROFILE',
    ]);
    expect(isOversightRole('SUPER_ADMIN')).toBe(true);
    expect(isPendingRole('PENDING_ROLE')).toBe(true);
    expect(satisfiesCapability('SUPER_ADMIN', 'CREATE_ACT')).toBe(false);
    expect(satisfiesCapability('SUPER_ADMIN', 'VIEW_HISTORY')).toBe(true);
    expect(capabilitiesForRole('ADMIN')).not.toContain('MANAGE_ADMIN_GRANTS');
    expect(hasCapability('SUPER_ADMIN', 'MANAGE_ADMIN_GRANTS')).toBe(true);
    expect(hasCapability('ADMIN', 'MANAGE_ADMIN_GRANTS')).toBe(false);
    expect(roleLabel('ADMIN')).toBe('Администратор');
    expect(roleLabel('SUPER_ADMIN')).toBe('Суперадминистратор');
    expect(roleLabel('PENDING_ROLE')).toBe('Ожидает назначение роли');
    expect(visibleProposalSlots('SUPER_ADMIN')).toEqual(['A', 'B', 'C']);
    expect(postLoginPath('SUPER_ADMIN')).toBe('/registry');
    expect(postLoginPath('PENDING_ROLE')).toBe('/pending-role');
    expect(postLoginPath('ADMIN')).toBe('/registry');
    expect(postLoginPath('SUPER_ADMIN', true)).toBe('/change-password');
  });
});

describe('registry query parsing', () => {
  it('applies defaults and rejects an invalid pageSize', () => {
    const parsed = parseRegistryListQuery({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(50);
    expect(parsed.sortBy).toBe('effectiveDeadline');
    expect(parsed.search).toBeNull();
    expect(() => parseRegistryListQuery({ pageSize: '30' })).toThrow(RegistryQueryError);
  });

  it('accepts only the sort whitelist and serializes empty filters as an empty map', () => {
    expect(() => parseRegistryListQuery({ sortBy: 'passwordHash' })).toThrow(RegistryQueryError);
    const query = parseRegistryListQuery({ sortBy: 'actNumber', sortDirection: 'desc' });
    expect(query.sortBy).toBe('actNumber');
    expect(serializeRegistryQuery(parseRegistryListQuery({}))).toEqual({});
    expect(countActiveRegistryFilters(parseRegistryListQuery({}))).toBe(0);
    expect(isEmptyRegistryQuery(parseRegistryListQuery({ search: '  ab' }))).toBe(false);
    const roundTrip = parseRegistryListQuery(
      serializeRegistryQuery(
        parseRegistryListQuery({
          page: '2',
          pageSize: '25',
          search: 'Северный',
          statuses: 'IN_PROGRESS',
          sortBy: 'actNumber',
          sortDirection: 'desc',
        }),
      ),
    );
    expect(roundTrip.page).toBe(2);
    expect(roundTrip.pageSize).toBe(25);
    expect(roundTrip.search).toBe('Северный');
    expect(roundTrip.statuses).toEqual(['IN_PROGRESS']);
    expect(() => parseRegistryListQuery({ pageSize: '50abc' })).toThrow(RegistryQueryError);
  });
});

describe('registry access and proposal shaping', () => {
  it('scopes responsible engineers to assigned objects and hides B/C', () => {
    expect(registryAccessMode('ADMIN')).toBe('all_uncancelled');
    expect(registryAccessMode('SGR_MANAGER')).toBe('all_uncancelled');
    expect(registryAccessMode('CONTRACTOR_ENGINEER')).toBe('all_uncancelled');
    expect(registryAccessMode('RESPONSIBLE_ENGINEER')).toBe('object_assigned');
    expect(isObjectScopedRole('RESPONSIBLE_ENGINEER')).toBe(true);
    expect(isObjectScopedRole('ADMIN')).toBe(false);
    expect(visibleProposalSlots('RESPONSIBLE_ENGINEER')).toEqual(['A']);
    expect(visibleProposalSlots('ADMIN')).toEqual(['A', 'B', 'C']);
    expect(canViewProposalASum('ADMIN')).toBe(true);
    expect(canViewProposalASum('SGR_MANAGER')).toBe(true);
    expect(canViewProposalASum('CONTRACTOR_ENGINEER')).toBe(false);
    expect(canViewProposalGroupBC('RESPONSIBLE_ENGINEER')).toBe(false);
  });
});

describe('deadlines', () => {
  const warningDays = 3;
  const today = new Date('2026-08-26T12:00:00.000Z');

  it('prefers claimDeadline over plannedDeadline', () => {
    const planned = calendarDateToUtcNoon('2026-08-20');
    const claim = calendarDateToUtcNoon('2026-09-01');
    expect(effectiveDeadlineOf({ plannedDeadline: planned, claimDeadline: claim })).toEqual(claim);
  });

  it('classifies NORMAL, WARNING, OVERDUE on the due date, NO_DEADLINE and COMPLETED', () => {
    const tz = 'Europe/Minsk';
    expect(
      deadlineStateOf({
        status: 'IN_PROGRESS',
        plannedDeadline: calendarDateToUtcNoon('2026-09-10'),
        claimDeadline: null,
        deadlineWarningDays: warningDays,
        now: today,
        timeZone: tz,
      }),
    ).toBe('NORMAL');
    expect(
      deadlineStateOf({
        status: 'IN_PROGRESS',
        plannedDeadline: calendarDateToUtcNoon('2026-08-28'),
        claimDeadline: null,
        deadlineWarningDays: warningDays,
        now: today,
        timeZone: tz,
      }),
    ).toBe('WARNING');
    expect(
      deadlineStateOf({
        status: 'IN_PROGRESS',
        plannedDeadline: calendarDateToUtcNoon('2026-08-26'),
        claimDeadline: null,
        deadlineWarningDays: warningDays,
        now: today,
        timeZone: tz,
      }),
    ).toBe('OVERDUE');
    expect(
      deadlineStateOf({
        status: 'IN_PROGRESS',
        plannedDeadline: null,
        claimDeadline: null,
        deadlineWarningDays: warningDays,
        now: today,
        timeZone: tz,
      }),
    ).toBe('NO_DEADLINE');
    expect(
      deadlineStateOf({
        status: 'COMPLETED',
        plannedDeadline: calendarDateToUtcNoon('2026-08-01'),
        claimDeadline: null,
        deadlineWarningDays: warningDays,
        now: today,
        timeZone: tz,
      }),
    ).toBe('COMPLETED');
  });

  it('uses date-only semantics in the business time zone', () => {
    expect(calendarDateInTimeZone(new Date('2026-08-26T21:30:00.000Z'), 'Europe/Minsk')).toBe(
      '2026-08-27',
    );
    expect(serializeDecimal({ toFixed: (digits: number) => (digits === 2 ? '1180.50' : '') })).toBe(
      '1180.50',
    );
    expect(() => serializeDecimal(1180.5)).toThrow();
    expect(formatProposalMoney('1250.00', 'BYN')).toBe('1 250,00 BYN');
    expect(formatProposalMoney('1180.50')).toBe('1 180,50 BYN');
    expect(formatProposalMoney('0.00')).toBe('0,00 BYN');
  });
});

describe('summary and proposal shaping', () => {
  const proposals = [
    { slot: 'A' as const, amount: '1250.00', currency: 'BYN', contractorName: 'A' },
    { slot: 'B' as const, amount: '1180.50', currency: 'BYN', contractorName: 'B' },
    { slot: 'C' as const, amount: '1310.00', currency: 'BYN', contractorName: 'C' },
  ];

  it('omits B/C keys for responsible engineers and keeps exact decimals', () => {
    const engineer = shapeProposals(proposals, 'RESPONSIBLE_ENGINEER');
    expect(engineer.proposalA?.amount).toBe('1250.00');
    expect(Object.prototype.hasOwnProperty.call(engineer, 'proposalsBC')).toBe(false);
    const admin = shapeProposals(proposals, 'ADMIN');
    expect(admin.proposalsBC?.map((item) => item.slot)).toEqual(['B', 'C']);
  });

  it('includes proposalASum only for ADMIN and SGR_MANAGER', () => {
    const base = { total: 2, currency: 'BYN' };
    expect(shapeSummary(base, 'ADMIN', '1180.50').proposalASum).toBe('1180.50');
    expect(shapeSummary(base, 'SGR_MANAGER', '1180.50').proposalASum).toBe('1180.50');
    expect(
      Object.prototype.hasOwnProperty.call(
        shapeSummary(base, 'RESPONSIBLE_ENGINEER', '1180.50'),
        'proposalASum',
      ),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(
        shapeSummary(base, 'CONTRACTOR_ENGINEER', '1180.50'),
        'proposalASum',
      ),
    ).toBe(false);
  });
});

describe('property object linked selection', () => {
  const objects = [
    {
      id: 'obj-north',
      name: 'ЖК «Северный парк»',
      address: 'г. Минск, ул. Вымышленная, 1',
    },
    {
      id: 'obj-north-2',
      name: 'ЖК «Северный парк»',
      address: 'г. Минск, пр. Другой, 5',
    },
    {
      id: 'obj-river',
      name: 'ЖК «Речной квартал»',
      address: 'г. Минск, ул. Вымышленная, 1',
    },
    {
      id: 'obj-archived',
      name: 'ЖК «Архивный корпус»',
      address: 'г. Минск, ул. Закрытая, 9',
      active: false,
    },
  ];

  it('filters by name and address without exact match, case or alphabet', () => {
    expect(filterPropertyObjects(objects, 'северный', 'name').map((item) => item.id)).toEqual([
      'obj-north',
      'obj-north-2',
    ]);
    expect(filterPropertyObjects(objects, 'ДРУГОЙ, 5', 'address').map((item) => item.id)).toEqual([
      'obj-north-2',
    ]);
    expect(selectablePropertyObjects(objects).some((item) => item.id === 'obj-archived')).toBe(
      false,
    );
  });

  it('distinguishes duplicate names and addresses by id', () => {
    const byName = filterPropertyObjects(objects, 'Северный парк', 'name');
    expect(byName).toHaveLength(2);
    expect(new Set(byName.map((item) => item.id)).size).toBe(2);
    const sameAddress = filterPropertyObjects(objects, 'ул. Вымышленная, 1', 'address');
    expect(sameAddress.map((item) => item.id).sort()).toEqual(['obj-north', 'obj-river']);
    expect(propertyObjectById(objects, 'obj-river')?.name).toBe('ЖК «Речной квартал»');
    expect(propertyObjectById(objects, 'obj-river')?.address).toBe('г. Минск, ул. Вымышленная, 1');
    expect(propertyObjectById(objects, null)).toBeNull();
  });

  it('restricts reference kinds for view-only responsible engineers', () => {
    expect(canAccessReferenceKind('RESPONSIBLE_ENGINEER', 'property-objects')).toBe(true);
    expect(canAccessReferenceKind('RESPONSIBLE_ENGINEER', 'organizations')).toBe(true);
    expect(canAccessReferenceKind('RESPONSIBLE_ENGINEER', 'work-types')).toBe(false);
    expect(canAccessReferenceKind('RESPONSIBLE_ENGINEER', 'defect-types')).toBe(false);
    expect(canAccessReferenceKind('CONTRACTOR_ENGINEER', 'property-objects')).toBe(false);
    expect(canAccessReferenceKind('ADMIN', 'defect-types')).toBe(true);
    expect(canAccessReferenceKind('SGR_MANAGER', 'organizations')).toBe(true);
  });
});
