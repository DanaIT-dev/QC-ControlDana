import { describe, expect, it } from 'vitest';
import { RegistryAccessScope } from '../../src/registry/registry-access-scope';
import {
  deadlineStateWhere,
  emptyActListWhere,
  registryOrderBy,
} from '../../src/registry/registry-query-builder';
import { parseRegistryListQuery, shapeProposals, shapeSummary } from '@sgr-registry/domain';
import { registryListSelect } from '../../src/registry/registry-serializer';

describe('RegistryAccessScope', () => {
  it('keeps object-assigned filtering inside the Prisma where for responsible engineers', () => {
    const scope = new RegistryAccessScope({
      id: '11111111-1111-4111-8111-111111111111',
      role: 'RESPONSIBLE_ENGINEER',
    });
    const where = scope.defectItemWhere();
    expect(JSON.stringify(where)).toContain('11111111-1111-4111-8111-111111111111');
    expect(JSON.stringify(where)).toContain('propertyObject');
    expect(JSON.stringify(where)).toContain('engineers');
    expect(JSON.stringify(where)).not.toContain('responsibleEngineers');
    expect(JSON.stringify(where)).toContain('CANCELLED');
  });

  it('does not assign responsible-engineer joins for the other three roles', () => {
    for (const role of ['ADMIN', 'MANAGER', 'SGR_MANAGER'] as const) {
      const where = new RegistryAccessScope({
        id: '11111111-1111-4111-8111-111111111111',
        role,
      }).defectItemWhere();
      expect(JSON.stringify(where)).not.toContain('engineers');
    }
  });
});

describe('registry query builder', () => {
  it('whitelists sort fields instead of passing a raw column name', () => {
    expect(registryOrderBy('actNumber', 'desc')[0]).toEqual({ act: { officialNumber: 'desc' } });
    expect(registryOrderBy('effectiveDeadline', 'asc')[2]).toEqual({ id: 'asc' });
  });

  it('includes an empty NEW act unless a defect-only filter excludes it', () => {
    const scope = new RegistryAccessScope({
      id: '11111111-1111-4111-8111-111111111111',
      role: 'ADMIN',
    });
    const open = emptyActListWhere(scope, parseRegistryListQuery({ statuses: 'NEW' }));
    expect(JSON.stringify(open)).toContain('NEW');
    expect(
      emptyActListWhere(scope, parseRegistryListQuery({ statuses: 'IN_PROGRESS' })),
    ).toBeNull();
    expect(
      emptyActListWhere(scope, parseRegistryListQuery({ deadlineState: 'OVERDUE' })),
    ).toBeNull();
  });

  it('encodes overdue-on-the-due-date in the database predicate', () => {
    const where = deadlineStateWhere('OVERDUE', '2026-08-26', 3);
    expect(where.status).toEqual({ in: ['IN_PROGRESS', 'PENDING_INSPECTION'] });
    expect(where.act).toEqual({ status: 'IN_PROGRESS' });
    expect(where.effectiveDeadline).toMatchObject({ lte: expect.any(Date) });
  });
});

describe('response shaping', () => {
  it('loads the contractor name in the list query instead of a per-row lookup', () => {
    expect(registryListSelect.proposals.select.alternativeContractor).toEqual({
      select: { officialName: true },
    });
    expect(Object.keys(registryListSelect.proposals.select.alternativeContractor.select)).toEqual([
      'officialName',
    ]);
  });

  it('does not emit a proposalsBC key for responsible engineers', () => {
    const shaped = shapeProposals(
      [
        { slot: 'A', amount: '10.00', currency: 'BYN', contractorName: 'A' },
        { slot: 'B', amount: '11.00', currency: 'BYN', contractorName: 'B' },
      ],
      'RESPONSIBLE_ENGINEER',
    );
    expect(Object.keys(shaped)).toEqual(['proposalA']);
  });

  it('omits proposalASum for contractor and responsible roles', () => {
    expect('proposalASum' in shapeSummary({ total: 1 }, 'CONTRACTOR_ENGINEER', '10.00')).toBe(
      false,
    );
  });
});
