import { describe, expect, it } from 'vitest';
import {
  canDecideActClosureRequest,
  canDirectCloseActWithoutInspection,
  canRequestActClosureWithoutInspection,
  closureApprovalRoute,
  closureDefectFingerprint,
} from './act-closure-approval';

const engineer = { id: 'engineer', role: 'RESPONSIBLE_ENGINEER' as const };
const other = { id: 'other', role: 'RESPONSIBLE_ENGINEER' as const };
const admin = { id: 'admin', role: 'ADMIN' as const };
const sgr = { id: 'sgr', role: 'SGR_MANAGER' as const };
const manager = { id: 'manager', role: 'MANAGER' as const };
const superAdmin = { id: 'super', role: 'SUPER_ADMIN' as const };

describe('act closure approval route', () => {
  it('keeps direct close and a request as separate rights', () => {
    expect(
      canDirectCloseActWithoutInspection({
        role: 'RESPONSIBLE_ENGINEER',
        assignedToObject: true,
        pendingRequest: false,
      }),
    ).toBe(true);
    expect(
      canRequestActClosureWithoutInspection({
        role: 'RESPONSIBLE_ENGINEER',
        canReadAct: true,
        assignedToObject: true,
        pendingRequest: false,
      }),
    ).toBe(false);
    expect(
      canDirectCloseActWithoutInspection({
        role: 'RESPONSIBLE_ENGINEER',
        assignedToObject: false,
        pendingRequest: false,
      }),
    ).toBe(false);
    expect(
      canRequestActClosureWithoutInspection({
        role: 'RESPONSIBLE_ENGINEER',
        canReadAct: true,
        assignedToObject: false,
        pendingRequest: false,
      }),
    ).toBe(true);
    expect(
      canRequestActClosureWithoutInspection({
        role: 'RESPONSIBLE_ENGINEER',
        canReadAct: false,
        assignedToObject: false,
        pendingRequest: false,
      }),
    ).toBe(false);
  });

  it('excludes MANAGER and blocks a pending request bypass except for SUPER_ADMIN', () => {
    for (const role of ['MANAGER', 'PENDING_ROLE', 'CONTRACTOR_ENGINEER', 'UNASSIGNED'] as const) {
      expect(
        canDirectCloseActWithoutInspection({
          role,
          assignedToObject: true,
          pendingRequest: false,
        }),
      ).toBe(false);
      expect(
        canDecideActClosureRequest({
          actor: { id: role, role },
          initiatorId: 'initiator',
          objectId: 'object',
          activeEngineerIds: [],
        }),
      ).toBe(false);
    }
    expect(
      canDirectCloseActWithoutInspection({
        role: 'ADMIN',
        assignedToObject: false,
        pendingRequest: true,
      }),
    ).toBe(false);
    expect(
      canDirectCloseActWithoutInspection({
        role: 'SGR_MANAGER',
        assignedToObject: false,
        pendingRequest: true,
      }),
    ).toBe(false);
    expect(
      canDirectCloseActWithoutInspection({
        role: 'SUPER_ADMIN',
        assignedToObject: false,
        pendingRequest: true,
      }),
    ).toBe(true);
  });

  it('routes the decision to object engineers, then ADMIN or SGR_MANAGER', () => {
    expect(closureApprovalRoute({ objectId: null, activeEngineerIds: ['a'] })).toBe('UNRESOLVED');
    expect(closureApprovalRoute({ objectId: 'object', activeEngineerIds: ['other'] })).toBe(
      'OBJECT_ENGINEERS',
    );
    expect(closureApprovalRoute({ objectId: 'object', activeEngineerIds: [] })).toBe('ADMIN_SGR');
    expect(
      canDecideActClosureRequest({
        actor: other,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [other.id, engineer.id],
      }),
    ).toBe(true);
    expect(
      canDecideActClosureRequest({
        actor: engineer,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [engineer.id],
      }),
    ).toBe(false);
    expect(
      canDecideActClosureRequest({
        actor: admin,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [other.id],
      }),
    ).toBe(false);
    expect(
      canDecideActClosureRequest({
        actor: sgr,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [other.id],
      }),
    ).toBe(false);
    expect(
      canDecideActClosureRequest({
        actor: admin,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [],
      }),
    ).toBe(true);
    expect(
      canDecideActClosureRequest({
        actor: sgr,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [],
      }),
    ).toBe(true);
    expect(
      canDecideActClosureRequest({
        actor: manager,
        initiatorId: engineer.id,
        objectId: 'object',
        activeEngineerIds: [],
      }),
    ).toBe(false);
    expect(
      canDecideActClosureRequest({
        actor: superAdmin,
        initiatorId: engineer.id,
        objectId: null,
        activeEngineerIds: [],
      }),
    ).toBe(true);
    expect(
      canDecideActClosureRequest({
        actor: admin,
        initiatorId: engineer.id,
        objectId: null,
        activeEngineerIds: [],
      }),
    ).toBe(false);
  });

  it('builds a stable defect fingerprint', () => {
    expect(
      closureDefectFingerprint([
        { id: 'b', version: 2, status: 'IN_PROGRESS' },
        { id: 'a', version: 1, status: 'COMPLETED' },
      ]),
    ).toBe('a:1:COMPLETED|b:2:IN_PROGRESS');
  });
});
