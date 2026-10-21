import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { CONFIRMED_LAST_FIRST_TOKEN_ORDER, personNameWriteFields } from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  postgresUrlWithoutSchema,
  signUserRlsContext,
} from '../../src/index';
import { assertSafeTestDatabaseUrl } from '../../src/test-database';

const migratorUrl = process.env.MIGRATION_DATABASE_URL ?? '';
const ownerUrl = process.env.TEST_DATABASE_URL ?? '';
const secret = process.env.RLS_CONTEXT_SECRET ?? '';
assertSafeTestDatabaseUrl(migratorUrl);
assertSafeTestDatabaseUrl(ownerUrl);

const owner = createOwnerPrismaClient(migratorUrl);
const marker = `eq-${randomUUID().slice(0, 8)}`;

const OLD_ACTS_POLICY = `
DROP POLICY IF EXISTS acts_select ON public.acts;
CREATE POLICY acts_select ON public.acts FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object("objectId")
    OR public.sgr_contractor_can_see_act(id)
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );
`;

const OLD_DEFECTS_POLICY = `
DROP POLICY IF EXISTS defects_select ON public.defect_items;
CREATE POLICY defects_select ON public.defect_items FOR SELECT TO sgr_app, sgr_worker
  USING (
    public.sgr_app_visible_object((SELECT a."objectId" FROM public.acts a WHERE a.id = "actId"))
    OR public.sgr_contractor_can_see_defect(id)
    OR public.sgr_is_super_admin()
    OR public.sgr_ctx_is_worker()
  );
`;

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'админ',
  MANAGER: 'менеджер',
  SGR_MANAGER: 'куратор',
  RESPONSIBLE_ENGINEER: 'инженер',
  CONTRACTOR_ENGINEER: 'подрядчик',
  SUPER_ADMIN: 'наблюдатель',
  PENDING_ROLE: 'ожидание',
};

describe('analytics visibility policy equivalence', () => {
  afterAll(async () => {
    await owner.$executeRaw`
      DELETE FROM public.analytics_insight_defects
      WHERE "contributionReason" = ${marker}
         OR "defectItemId" IN (
           SELECT id FROM public.defect_items WHERE location LIKE ${`${marker}%`}
         )
    `.catch(() => undefined);
    await owner.analyticsInsight
      .deleteMany({
        where: { snapshotHash: { startsWith: marker } },
      })
      .catch(() => undefined);
    await owner.defectItemLiableOrganization
      .deleteMany({
        where: { defectItem: { location: { startsWith: marker } } },
      })
      .catch(() => undefined);
    await owner.defectItem
      .deleteMany({ where: { location: { startsWith: marker } } })
      .catch(() => undefined);
    await owner.act
      .deleteMany({ where: { officialNumber: { startsWith: marker } } })
      .catch(() => undefined);
    const users = await owner.user.findMany({
      where: { email: { startsWith: marker } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    if (userIds.length > 0) {
      await owner.userOrganizationMembership
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => undefined);
      await owner.propertyObjectEngineer
        .deleteMany({ where: { userId: { in: userIds } } })
        .catch(() => undefined);
      await owner.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    }
    await owner.propertyObject
      .deleteMany({ where: { name: { startsWith: marker } } })
      .catch(() => undefined);
    await owner.organization
      .deleteMany({ where: { email: { startsWith: marker } } })
      .catch(() => undefined);
    await owner.$disconnect();
  });

  it('keeps the same act, defect, insight, and support ids for every role', async () => {
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const roles = [
      'ADMIN',
      'MANAGER',
      'SGR_MANAGER',
      'RESPONSIBLE_ENGINEER',
      'CONTRACTOR_ENGINEER',
      'SUPER_ADMIN',
      'PENDING_ROLE',
    ] as const;
    const users = new Map<string, string>();
    const versions = new Map<string, number>();
    const createdUserIds: string[] = [];
    const existingSuperAdmin = await owner.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
      select: { id: true, sessionVersion: true },
    });
    if (existingSuperAdmin) {
      users.set('SUPER_ADMIN', existingSuperAdmin.id);
      versions.set('SUPER_ADMIN', existingSuperAdmin.sessionVersion);
    } else {
      const createdSuperAdmin = await owner.user.create({
        data: {
          ...personNameWriteFields(
            `${marker} ${ROLE_LABEL.SUPER_ADMIN}`,
            CONFIRMED_LAST_FIRST_TOKEN_ORDER,
          ),
          email: `${marker}.super@example.sgr.local`,
          role: 'SUPER_ADMIN',
          sessionVersion: 1,
        },
      });
      users.set('SUPER_ADMIN', createdSuperAdmin.id);
      versions.set('SUPER_ADMIN', createdSuperAdmin.sessionVersion);
      createdUserIds.push(createdSuperAdmin.id);
    }
    for (const role of roles) {
      if (role === 'SUPER_ADMIN') {
        continue;
      }
      const user = await owner.user.create({
        data: {
          ...personNameWriteFields(
            `${marker} ${ROLE_LABEL[role]}`,
            CONFIRMED_LAST_FIRST_TOKEN_ORDER,
          ),
          email: `${marker}.${role.toLowerCase()}@example.sgr.local`,
          role,
          sessionVersion: 1,
        },
      });
      users.set(role, user.id);
      versions.set(role, 1);
      createdUserIds.push(user.id);
    }
    const orgA = await owner.organization.create({
      data: {
        officialName: `${marker} org a`,
        postalAddress: 'addr',
        email: `${marker}.a@example.sgr.local`,
        phone: '1',
        contactPerson: 'C',
      },
    });
    const orgB = await owner.organization.create({
      data: {
        officialName: `${marker} org b`,
        postalAddress: 'addr',
        email: `${marker}.b@example.sgr.local`,
        phone: '1',
        contactPerson: 'C',
      },
    });
    const objectA = await owner.propertyObject.create({
      data: { name: `${marker} object a`, address: `${marker} address a` },
    });
    const objectB = await owner.propertyObject.create({
      data: { name: `${marker} object b`, address: `${marker} address b` },
    });
    const adminId = users.get('ADMIN') ?? '';
    const responsibleId = users.get('RESPONSIBLE_ENGINEER') ?? '';
    const contractorId = users.get('CONTRACTOR_ENGINEER') ?? '';
    await owner.propertyObjectEngineer.create({
      data: { propertyObjectId: objectA.id, userId: responsibleId, assignedByUserId: adminId },
    });
    await owner.userOrganizationMembership.create({
      data: { userId: contractorId, organizationId: orgA.id, assignedByUserId: adminId },
    });
    await owner.propertyObjectEngineer.create({
      data: { propertyObjectId: objectA.id, userId: contractorId, assignedByUserId: adminId },
    });
    const sequence = Math.floor(Math.random() * 800_000) + 100_000;
    const actA = await owner.act.create({
      data: {
        officialNumber: `${marker}-a`,
        formCode: 'S1',
        year: 2099,
        sequence,
        objectId: objectA.id,
        customerOrganizationId: orgA.id,
        issuedOn: new Date('2026-03-01T12:00:00.000Z'),
        status: 'IN_PROGRESS',
        createdAt: new Date('2026-03-01T12:00:00.000Z'),
        startedAt: new Date('2026-03-01T12:00:00.000Z'),
      },
    });
    const actB = await owner.act.create({
      data: {
        officialNumber: `${marker}-b`,
        formCode: 'S1',
        year: 2099,
        sequence: sequence + 1,
        objectId: objectB.id,
        customerOrganizationId: orgB.id,
        issuedOn: new Date('2026-03-02T12:00:00.000Z'),
        status: 'IN_PROGRESS',
        createdAt: new Date('2026-03-02T12:00:00.000Z'),
        startedAt: new Date('2026-03-02T12:00:00.000Z'),
      },
    });
    const defectType = await owner.defectType.upsert({
      where: { code: 'EQ_POLICY' },
      update: {},
      create: { code: 'EQ_POLICY', name: 'Policy equivalence', sortOrder: 901, active: true },
    });
    const defectA = await owner.defectItem.create({
      data: {
        actId: actA.id,
        location: `${marker} a`,
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    const defectB = await owner.defectItem.create({
      data: {
        actId: actB.id,
        location: `${marker} b`,
        claimDetails: 'claim',
        defectTypeId: defectType.id,
      },
    });
    await owner.defectItemLiableOrganization.create({
      data: { defectItemId: defectA.id, organizationId: orgA.id },
    });
    await owner.defectItemLiableOrganization.create({
      data: { defectItemId: defectB.id, organizationId: orgB.id },
    });
    const insightBase = {
      signalType: 'LOW_FIRST_TIME_RIGHT',
      title: 'проверка',
      plainLanguageExplanation: 'Наблюдается связь.',
      dimensions: [],
      supportCount: 1,
      totalCount: 2,
      observedValue: '0.100000',
      baselineValue: '0.800000',
      confidence: 'low',
      generatedAt: new Date('2026-06-01T00:00:00.000Z'),
      ruleVersion: '2026.10.05.2',
      filterSnapshot: {},
      filterHash: marker,
      supportAvailable: true,
    };
    const companyInsight = await owner.analyticsInsight.create({
      data: {
        ...insightBase,
        signalKey: `${marker}:company`,
        scopeKind: 'COMPANY',
        scopeFingerprint: 'company',
        snapshotHash: `${marker}:company`,
      },
    });
    const contractorInsight = await owner.analyticsInsight.create({
      data: {
        ...insightBase,
        signalKey: `${marker}:org`,
        scopeKind: 'ORGANIZATION',
        scopeFingerprint: `org:${orgA.id}`,
        scopeOrganizationId: orgA.id,
        snapshotHash: `${marker}:org`,
      },
    });
    const foreignInsight = await owner.analyticsInsight.create({
      data: {
        ...insightBase,
        signalKey: `${marker}:foreign`,
        scopeKind: 'ORGANIZATION',
        scopeFingerprint: `org:${orgB.id}`,
        scopeOrganizationId: orgB.id,
        snapshotHash: `${marker}:foreign`,
      },
    });
    const companySupport = await owner.analyticsInsightDefect.create({
      data: {
        insightId: companyInsight.id,
        defectItemId: defectA.id,
        contributionReason: marker,
        observedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    const contractorSupport = await owner.analyticsInsightDefect.create({
      data: {
        insightId: contractorInsight.id,
        defectItemId: defectA.id,
        contributionReason: marker,
        observedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    const foreignSupport = await owner.analyticsInsightDefect.create({
      data: {
        insightId: foreignInsight.id,
        defectItemId: defectB.id,
        contributionReason: marker,
        observedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
    });

    const pool = new Pool({ connectionString: postgresUrlWithoutSchema(ownerUrl), max: 1 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await collect(client, roles, users, versions);
      await client.query('RESET ROLE');
      await client.query(OLD_ACTS_POLICY);
      await client.query(OLD_DEFECTS_POLICY);
      const previous = await collect(client, roles, users, versions);
      for (const role of roles) {
        assertSameSet(role, 'acts', current[role]?.acts ?? [], previous[role]?.acts ?? []);
        assertSameSet(role, 'defects', current[role]?.defects ?? [], previous[role]?.defects ?? []);
        assertSameSet(
          role,
          'insights',
          current[role]?.insights ?? [],
          previous[role]?.insights ?? [],
        );
        assertSameSet(role, 'support', current[role]?.support ?? [], previous[role]?.support ?? []);
      }
      const contractor = current.CONTRACTOR_ENGINEER;
      expect(contractor?.defects).toContain(defectA.id);
      expect(contractor?.defects).not.toContain(defectB.id);
      expect(contractor?.acts).toContain(actA.id);
      expect(contractor?.acts).not.toContain(actB.id);
      expect(contractor?.insights).toContain(contractorInsight.id);
      expect(contractor?.insights).not.toContain(companyInsight.id);
      expect(contractor?.insights).not.toContain(foreignInsight.id);
      expect(contractor?.support).toContain(contractorSupport.id);
      expect(contractor?.support).not.toContain(companySupport.id);
      expect(contractor?.support).not.toContain(foreignSupport.id);
      const responsible = current.RESPONSIBLE_ENGINEER;
      expect(responsible?.defects).toContain(defectA.id);
      expect(responsible?.defects).not.toContain(defectB.id);
      expect(responsible?.acts).toContain(actA.id);
      expect(responsible?.acts).not.toContain(actB.id);
      expect(responsible?.insights).not.toContain(companyInsight.id);
      expect(responsible?.insights).not.toContain(foreignInsight.id);
      const pending = current.PENDING_ROLE;
      expect(pending?.defects).toEqual([]);
      expect(pending?.acts).toEqual([]);
      expect(pending?.insights).toEqual([]);
      expect(pending?.support).toEqual([]);
      for (const role of ['ADMIN', 'MANAGER', 'SGR_MANAGER', 'SUPER_ADMIN'] as const) {
        expect(current[role]?.defects).toEqual(expect.arrayContaining([defectA.id, defectB.id]));
        expect(current[role]?.acts).toEqual(expect.arrayContaining([actA.id, actB.id]));
      }
      expect(current.SUPER_ADMIN?.insights).toEqual(
        expect.arrayContaining([companyInsight.id, contractorInsight.id, foreignInsight.id]),
      );
      await client.query('RESET ROLE');
      await client.query('SET ROLE sgr_app');
      await client.query('SELECT sgr_set_request_context($1)', [
        signUserRlsContext(
          {
            userId: users.get('SUPER_ADMIN') ?? '',
            sessionVersion: versions.get('SUPER_ADMIN') ?? 1,
          },
          secret,
        ),
      ]);
      const actor = await client.query<{ current_user: string }>('SELECT current_user');
      expect(actor.rows[0]?.current_user).toBe('sgr_app');
      await client.query('SAVEPOINT super_admin_insert');
      const inserted = await client.query(
        `INSERT INTO public.defect_items (id, "actId", location, "claimDetails", "defectTypeId", "createdAt", "updatedAt")
         VALUES ($1, $2, 'x', 'x', $3, now(), now())`,
        [randomUUID(), actA.id, defectType.id],
      );
      expect(inserted.rowCount).toBe(1);
      await client.query('ROLLBACK TO SAVEPOINT super_admin_insert');
      await client.query('RESET ROLE');
      await client.query('DELETE FROM public.analytics_insight_defects WHERE id = $1', [
        contractorSupport.id,
      ]);
      const responsibleUserId = users.get('RESPONSIBLE_ENGINEER') ?? '';
      const assignedInsight = await client.query<{ id: string }>(
        `INSERT INTO public.analytics_insights (
           "signalKey", "signalType", title, "plainLanguageExplanation", dimensions,
           "supportCount", "totalCount", "observedValue", "baselineValue", confidence,
           "generatedAt", "ruleVersion", "scopeKind", "scopeFingerprint", "scopeUserId",
           "filterSnapshot", "filterHash", "snapshotHash", "supportAvailable"
         )
         SELECT "signalKey" || ':assigned', "signalType", title, "plainLanguageExplanation", dimensions,
                "supportCount", "totalCount", "observedValue", "baselineValue", confidence,
                "generatedAt", "ruleVersion", 'ASSIGNED'::public."AnalyticsScopeKind",
                'user:' || $2::text, $2::uuid,
                "filterSnapshot", "filterHash", "snapshotHash" || ':assigned', "supportAvailable"
         FROM public.analytics_insights
         WHERE id = $1
         RETURNING id::text AS id`,
        [companyInsight.id, responsibleUserId],
      );
      const assignedInsightId = assignedInsight.rows[0]?.id ?? '';
      await client.query('SET ROLE sgr_app');
      await assertSupportWrite(client, 'ADMIN', users, versions, secret, async () => {
        const inserted = await client.query<{ n: number }>(
          `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])::int AS n`,
          [companyInsight.id, marker, defectB.id],
        );
        expect(inserted.rows[0]?.n).toBe(1);
        await expectDenied(
          client,
          `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])`,
          [contractorInsight.id, marker, defectA.id],
        );
      });
      await assertSupportWrite(client, 'CONTRACTOR_ENGINEER', users, versions, secret, async () => {
        const inserted = await client.query<{ n: number }>(
          `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])::int AS n`,
          [contractorInsight.id, marker, defectA.id],
        );
        expect(inserted.rows[0]?.n).toBe(1);
        await expectDenied(
          client,
          `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])`,
          [contractorInsight.id, marker, defectB.id],
        );
        await expectDenied(
          client,
          `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])`,
          [companyInsight.id, marker, defectA.id],
        );
      });
      await assertSupportWrite(
        client,
        'RESPONSIBLE_ENGINEER',
        users,
        versions,
        secret,
        async () => {
          const inserted = await client.query<{ n: number }>(
            `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])::int AS n`,
            [assignedInsightId, marker, defectA.id],
          );
          expect(inserted.rows[0]?.n).toBe(1);
          await expectDenied(
            client,
            `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])`,
            [assignedInsightId, marker, defectB.id],
          );
          await expectDenied(
            client,
            `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])`,
            [companyInsight.id, marker, defectA.id],
          );
        },
      );
      for (const role of ['PENDING_ROLE'] as const) {
        await assertSupportWrite(client, role, users, versions, secret, async () => {
          await expectDenied(
            client,
            `SELECT public.sgr_insert_insight_support($1::uuid, $2, now(), ARRAY[$3::uuid])`,
            [companyInsight.id, marker, defectA.id],
          );
        });
      }
      await client.query('RESET ROLE');
      await client.query('SET ROLE sgr_app');
      await client.query('SELECT sgr_set_request_context($1)', [
        signUserRlsContext(
          { userId: users.get('ADMIN') ?? '', sessionVersion: versions.get('ADMIN') ?? 1 },
          secret,
        ),
      ]);
      await client.query(
        'CREATE TEMP TABLE analytics_scope_defects (id uuid PRIMARY KEY) ON COMMIT DROP',
      );
      await client.query('INSERT INTO analytics_scope_defects (id) VALUES ($1)', [defectA.id]);
      const intersection = await client.query<{ hit: boolean }>(
        'SELECT public.sgr_insight_intersects_scope($1::uuid) AS hit',
        [companyInsight.id],
      );
      expect(intersection.rows[0]?.hit).toBe(true);
      await client.query('DELETE FROM analytics_scope_defects');
      await client.query('INSERT INTO analytics_scope_defects (id) VALUES ($1)', [randomUUID()]);
      const missed = await client.query<{ hit: boolean }>(
        'SELECT public.sgr_insight_intersects_scope($1::uuid) AS hit',
        [companyInsight.id],
      );
      expect(missed.rows[0]?.hit).toBe(false);
      const staffExtra = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT id FROM public.sgr_staff_defect_items()
           EXCEPT
           SELECT id FROM public.defect_items
         ) extra`,
      );
      const staffMissing = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT id FROM public.defect_items
           EXCEPT
           SELECT id FROM public.sgr_staff_defect_items()
         ) missing`,
      );
      expect(staffExtra.rows[0]?.n).toBe(0);
      expect(staffMissing.rows[0]?.n).toBe(0);
      for (const role of ['CONTRACTOR_ENGINEER', 'RESPONSIBLE_ENGINEER', 'PENDING_ROLE'] as const) {
        await assertSupportWrite(client, role, users, versions, secret, async () => {
          await expectDenied(client, 'SELECT id FROM public.sgr_staff_defect_items()', []);
        });
      }
      await assertSupportWrite(client, 'SUPER_ADMIN', users, versions, secret, async () => {
        const staffRows = await client.query('SELECT id FROM public.sgr_staff_defect_items()');
        expect(staffRows.rowCount).toBeGreaterThan(0);
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end();
      const policy = await owner.$queryRaw<Array<{ expression: string }>>`
        SELECT pg_get_expr(pol.polqual, pol.polrelid) AS expression
        FROM pg_policy pol
        JOIN pg_class cls ON cls.oid = pol.polrelid
        WHERE cls.relname = 'defect_items' AND pol.polname = 'defects_select'
      `;
      expect(policy[0]?.expression ?? '').toContain('sgr_is_staff');
      await owner.analyticsInsightDefect.deleteMany({
        where: { id: { in: [companySupport.id, contractorSupport.id, foreignSupport.id] } },
      });
      await owner.analyticsInsight.deleteMany({
        where: { id: { in: [companyInsight.id, contractorInsight.id, foreignInsight.id] } },
      });
      await owner.defectItemLiableOrganization.deleteMany({
        where: { defectItemId: { in: [defectA.id, defectB.id] } },
      });
      await owner.defectItem.deleteMany({ where: { id: { in: [defectA.id, defectB.id] } } });
      await owner.userOrganizationMembership.deleteMany({ where: { userId: contractorId } });
      await owner.propertyObjectEngineer.deleteMany({
        where: { propertyObjectId: { in: [objectA.id, objectB.id] } },
      });
      await owner.act.deleteMany({ where: { id: { in: [actA.id, actB.id] } } });
      await owner.propertyObject.deleteMany({ where: { id: { in: [objectA.id, objectB.id] } } });
      await owner.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
      await owner.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  }, 120_000);
});

async function expectDenied(client: PoolClient, sql: string, params: unknown[]): Promise<void> {
  await client.query('SAVEPOINT denied_write');
  await expect(client.query(sql, params)).rejects.toMatchObject({ code: '42501' });
  await client.query('ROLLBACK TO SAVEPOINT denied_write');
}

async function assertSupportWrite(
  client: PoolClient,
  role: string,
  users: Map<string, string>,
  versions: Map<string, number>,
  rlsSecret: string,
  run: () => Promise<void>,
): Promise<void> {
  await client.query('SELECT sgr_set_request_context($1)', [
    signUserRlsContext(
      { userId: users.get(role) ?? '', sessionVersion: versions.get(role) ?? 1 },
      rlsSecret,
    ),
  ]);
  const actor = await client.query<{ current_user: string }>('SELECT current_user');
  if (actor.rows[0]?.current_user !== 'sgr_app') {
    throw new Error('support insert ran outside sgr_app');
  }
  await run();
  await client.query('SELECT sgr_clear_request_context()');
}

async function collect(
  client: PoolClient,
  roles: readonly string[],
  users: Map<string, string>,
  versions: Map<string, number>,
): Promise<
  Record<string, { acts: string[]; defects: string[]; insights: string[]; support: string[] }>
> {
  const result: Record<
    string,
    { acts: string[]; defects: string[]; insights: string[]; support: string[] }
  > = {};
  await client.query('SET ROLE sgr_app');
  const actor = await client.query<{ current_user: string }>('SELECT current_user');
  if (actor.rows[0]?.current_user !== 'sgr_app') {
    throw new Error('user query ran as the owner role');
  }
  for (const role of roles) {
    await client.query('SELECT sgr_set_request_context($1)', [
      signUserRlsContext(
        { userId: users.get(role) ?? '', sessionVersion: versions.get(role) ?? 1 },
        secret,
      ),
    ]);
    result[role] = {
      acts: await ids(client, 'public.acts'),
      defects: await ids(client, 'public.defect_items'),
      insights: await ids(client, 'public.analytics_insights'),
      support: await ids(client, 'public.analytics_insight_defects'),
    };
    await client.query('SELECT sgr_clear_request_context()');
  }
  await client.query('RESET ROLE');
  return result;
}

async function ids(client: PoolClient, table: string): Promise<string[]> {
  const rows = await client.query<{ id: string }>(`SELECT id::text AS id FROM ${table} ORDER BY 1`);
  return rows.rows.map((row) => row.id);
}

function assertSameSet(role: string, table: string, current: string[], previous: string[]): void {
  const currentIds = new Set(current);
  const previousIds = new Set(previous);
  const added = previous.filter((id) => !currentIds.has(id)).slice(0, 5);
  const removed = current.filter((id) => !previousIds.has(id)).slice(0, 5);
  expect({
    role,
    table,
    added,
    removed,
    current: current.length,
    previous: previous.length,
  }).toEqual({
    role,
    table,
    added: [],
    removed: [],
    current: current.length,
    previous: current.length,
  });
}
