import { Inject, Injectable } from '@nestjs/common';
import type { SlaListResponse, SlaSummaryResponse } from '@sgr-registry/contracts';
import type { Prisma } from '@sgr-registry/database';
import {
  DEFAULT_SLA_PAGE_SIZE,
  addCalendarDays,
  calendarDateInTimeZone,
  calendarDateToUtcNoon,
  canReceiveDeadlineKind,
  daysUntilDeadline,
  overdueDaysOf,
  parseSlaListQuery,
  reachedEscalationThresholds,
  slaStateOf,
  formatPersonShort,
} from '@sgr-registry/domain';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { resolveRegistryAccessScope } from '../registry/registry-access-scope.js';

@Injectable()
export class SlaQueryService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get prisma() {
    return this.prismaService.client;
  }

  async summary(user: AuthenticatedUser): Promise<SlaSummaryResponse> {
    const base = await this.baseWhere(user);
    const [warning, dueToday, overdue1to2, overdue3to6, overdue7plus, noDeadline] =
      await Promise.all([
        this.prisma.slaClock.count({ where: { ...base, ...this.bucketWhere('WARNING') } }),
        this.prisma.slaClock.count({ where: { ...base, ...this.bucketWhere('DUE_TODAY') } }),
        this.prisma.slaClock.count({ where: { ...base, ...this.bucketWhere('OVERDUE_1_2') } }),
        this.prisma.slaClock.count({ where: { ...base, ...this.bucketWhere('OVERDUE_3_6') } }),
        this.prisma.slaClock.count({ where: { ...base, ...this.bucketWhere('OVERDUE_7_PLUS') } }),
        this.prisma.slaClock.count({ where: { ...base, ...this.bucketWhere('NO_DEADLINE') } }),
      ]);
    return { warning, dueToday, overdue1to2, overdue3to6, overdue7plus, noDeadline };
  }

  async list(
    user: AuthenticatedUser,
    query: Record<string, string | undefined>,
  ): Promise<SlaListResponse> {
    const parsed = parseSlaListQuery(query);
    const page = parsed.page ?? 1;
    const pageSize = parsed.pageSize ?? DEFAULT_SLA_PAGE_SIZE;
    const where: Prisma.SlaClockWhereInput = {
      ...(await this.baseWhere(user, parsed.kind)),
      ...(parsed.bucket ? this.bucketWhere(parsed.bucket) : {}),
    };
    const orderBy: Prisma.SlaClockOrderByWithRelationInput[] =
      parsed.sortBy === 'actNumber'
        ? [
            {
              defectItem: {
                act: { officialNumber: parsed.sortDirection === 'desc' ? 'desc' : 'asc' },
              },
            },
            { defectItemId: 'asc' },
          ]
        : [{ deadline: parsed.sortDirection === 'desc' ? 'desc' : 'asc' }, { defectItemId: 'asc' }];
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.slaClock.count({ where }),
      this.prisma.slaClock.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          kind: true,
          deadline: true,
          defectItem: {
            select: {
              id: true,
              actId: true,
              location: true,
              status: true,
              act: {
                select: {
                  officialNumber: true,
                  formCode: true,
                  propertyObject: { select: { name: true } },
                },
              },
              defectType: { select: { name: true } },
              responsibleEngineers: {
                select: {
                  user: {
                    select: { lastName: true, firstName: true, middleName: true, fullName: true },
                  },
                },
              },
              importedEngineerReferences: {
                where: { resolutionStatus: 'UNMATCHED' },
                select: { sourceNameRaw: true },
              },
            },
          },
        },
      }),
    ]);
    const settings = await this.prisma.systemSettings.findUnique({ where: { id: 'default' } });
    const warningDays = settings?.deadlineWarningDays ?? 3;
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => {
        const state = slaStateOf({
          status: row.defectItem.status,
          deadline: row.deadline,
          warningDays,
        });
        const overdueDays = overdueDaysOf({ deadline: row.deadline });
        return {
          defectItemId: row.defectItem.id,
          actId: row.defectItem.actId,
          officialNumber: row.defectItem.act.officialNumber ?? 'Без номера',
          formCode: row.defectItem.act.formCode,
          objectName: row.defectItem.act.propertyObject.name,
          location: row.defectItem.location ?? '—',
          defectTypeName: row.defectItem.defectType.name,
          responsibleNames: [
            ...row.defectItem.responsibleEngineers.map((item) =>
              formatPersonShort({
                lastName: item.user.lastName,
                firstName: item.user.firstName,
                middleName: item.user.middleName,
              }),
            ),
            ...row.defectItem.importedEngineerReferences.map((item) => item.sourceNameRaw),
          ],
          kind: row.kind,
          deadline: row.deadline ? row.deadline.toISOString() : null,
          daysOffset: daysUntilDeadline({ deadline: row.deadline }),
          state,
          escalationLevel: reachedEscalationThresholds(overdueDays).at(-1) ?? null,
          status: row.defectItem.status,
        };
      }),
    };
  }

  private async baseWhere(
    user: AuthenticatedUser,
    kind?: 'GENERAL' | 'THIRD_PARTY',
  ): Promise<Prisma.SlaClockWhereInput> {
    const scope = await resolveRegistryAccessScope(this.prisma, user);
    const kinds = (['GENERAL', 'THIRD_PARTY'] as const).filter((item) =>
      canReceiveDeadlineKind(user.role, item),
    );
    const selected = kind ? kinds.filter((item) => item === kind) : kinds;
    return {
      kind: { in: selected },
      defectItem: {
        AND: [scope.defectItemWhere(), { status: { in: ['IN_PROGRESS', 'PENDING_INSPECTION'] } }],
      },
    };
  }

  private bucketWhere(bucket: string): Prisma.SlaClockWhereInput {
    const today = calendarDateInTimeZone(new Date());
    const utc = (offset: number) => calendarDateToUtcNoon(addCalendarDays(today, offset));
    switch (bucket) {
      case 'NO_DEADLINE':
        return { deadline: null };
      case 'WARNING':
        return { state: 'WARNING' };
      case 'DUE_TODAY':
        return { state: 'DUE_TODAY' };
      case 'OVERDUE_1_2':
        return { deadline: { gte: utc(-2), lt: utc(0) } };
      case 'OVERDUE_3_6':
        return { deadline: { gte: utc(-6), lt: utc(-2) } };
      case 'OVERDUE_7_PLUS':
        return { deadline: { lt: utc(-6) } };
      default:
        return {};
    }
  }
}
