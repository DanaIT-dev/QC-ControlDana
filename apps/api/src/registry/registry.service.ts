import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type {
  ActDetailDefectItem,
  ActDetailResponse,
  RegistryFilterOptionsResponse,
  RegistryListResponse,
  RegistrySummaryResponse,
} from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  calendarDateInTimeZone,
  canViewProposalASum,
  deadlineStateLabel,
  deadlineStateOf,
  defectItemStatusLabel,
  effectiveDeadlineOf,
  formLabel,
  normalizeQueryInput,
  parseRegistryListQuery,
  RegistryQueryError,
  shapeProposals,
  shapeSummary,
  visibleProposalSlots,
} from '@sgr-registry/domain';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../auth/prisma.tokens';
import { RegistryAccessScope } from './registry-access-scope';
import { deadlineStateWhere, registryListWhere, registryOrderBy } from './registry-query-builder';
import {
  calendarField,
  registryListSelect,
  timestampField,
  toActHeader,
  toRegistryRow,
} from './registry-serializer';

const COLLATOR = new Intl.Collator('ru', { sensitivity: 'base' });

@Injectable()
export class RegistryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    rawQuery: Record<string, unknown>,
  ): Promise<RegistryListResponse> {
    const { query, scope, todayIso, warningDays, now, timeZone } = await this.prepare(
      user,
      rawQuery,
    );
    const where = registryListWhere(scope, query, todayIso, warningDays);
    const totalCount = await this.prisma.client.defectItem.count({ where });
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / query.pageSize);
    const page = totalCount === 0 ? 1 : Math.min(query.page, Math.max(totalPages, 1));
    const items = await this.prisma.client.defectItem.findMany({
      where,
      select: {
        ...registryListSelect,
        proposals: {
          ...registryListSelect.proposals,
          where: { slot: { in: visibleProposalSlots(user.role) } },
        },
      },
      orderBy: registryOrderBy(query.sortBy, query.sortDirection),
      skip: (page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return {
      items: items.map((item) => toRegistryRow(item, user.role, warningDays, now, timeZone)),
      page,
      pageSize: query.pageSize,
      totalCount,
      totalPages,
      appliedSort: { sortBy: query.sortBy, sortDirection: query.sortDirection },
    };
  }

  async summary(
    user: AuthenticatedUser,
    rawQuery: Record<string, unknown>,
  ): Promise<RegistrySummaryResponse> {
    const { query, scope, todayIso, warningDays } = await this.prepare(user, rawQuery);
    const where = registryListWhere(scope, query, todayIso, warningDays);
    const [total, inProgress, completed, warning, overdue, noDeadline, proposalSum] =
      await Promise.all([
        this.prisma.client.defectItem.count({ where }),
        this.prisma.client.defectItem.count({ where: { AND: [where, { status: 'IN_PROGRESS' }] } }),
        this.prisma.client.defectItem.count({ where: { AND: [where, { status: 'COMPLETED' }] } }),
        this.prisma.client.defectItem.count({
          where: { AND: [where, deadlineStateWhere('WARNING', todayIso, warningDays)] },
        }),
        this.prisma.client.defectItem.count({
          where: { AND: [where, deadlineStateWhere('OVERDUE', todayIso, warningDays)] },
        }),
        this.prisma.client.defectItem.count({
          where: { AND: [where, deadlineStateWhere('NO_DEADLINE', todayIso, warningDays)] },
        }),
        canViewProposalASum(user.role)
          ? this.prisma.client.proposal.aggregate({
              _sum: { amount: true },
              where: { slot: 'A', defectItem: where },
            })
          : Promise.resolve(null),
      ]);
    return shapeSummary(
      {
        total,
        inProgress,
        completed,
        warning,
        overdue,
        noDeadline,
        currency: 'BYN',
        deadlineWarningDays: warningDays,
        businessDate: todayIso,
      },
      user.role,
      proposalSum?._sum.amount ?? '0.00',
    );
  }

  async filterOptions(user: AuthenticatedUser): Promise<RegistryFilterOptionsResponse> {
    const scope = new RegistryAccessScope(user);
    const itemWhere = scope.defectItemWhere();
    const [
      formRows,
      statusRows,
      objectRows,
      defectTypeRows,
      customerRows,
      liableRows,
      engineerRows,
    ] = await Promise.all([
      this.prisma.client.act.findMany({
        where: { defectItems: { some: itemWhere } },
        distinct: ['formCode'],
        select: { formCode: true },
      }),
      this.prisma.client.defectItem.findMany({
        where: itemWhere,
        distinct: ['status'],
        select: { status: true },
      }),
      this.prisma.client.propertyObject.findMany({
        where: { acts: { some: { defectItems: { some: itemWhere } } } },
        select: { id: true, name: true },
      }),
      this.prisma.client.defectType.findMany({
        where: { defectItems: { some: itemWhere } },
        select: { id: true, name: true },
      }),
      this.prisma.client.organization.findMany({
        where: { customerActs: { some: { defectItems: { some: itemWhere } } } },
        select: { id: true, officialName: true },
      }),
      this.prisma.client.organization.findMany({
        where: { liableItems: { some: { defectItem: itemWhere } } },
        select: { id: true, officialName: true },
      }),
      this.prisma.client.user.findMany({
        where: { defectItemAssignments: { some: { defectItem: itemWhere } } },
        select: { id: true, fullName: true },
      }),
    ]);

    return {
      formCodes: sortOptions(formRows.map((row) => [row.formCode, formLabel(row.formCode)])),
      statuses: sortOptions(
        statusRows.map((row) => [row.status, defectItemStatusLabel(row.status)]),
      ),
      objects: sortOptions(objectRows.map((row) => [row.id, row.name])),
      defectTypes: sortOptions(defectTypeRows.map((row) => [row.id, row.name])),
      customers: sortOptions(customerRows.map((row) => [row.id, row.officialName])),
      liableOrganizations: sortOptions(liableRows.map((row) => [row.id, row.officialName])),
      responsibleEngineers: sortOptions(engineerRows.map((row) => [row.id, row.fullName])),
    };
  }

  async actDetail(user: AuthenticatedUser, actId: string): Promise<ActDetailResponse> {
    const scope = new RegistryAccessScope(user);
    const warningDays = await this.warningDays();
    const timeZone = loadConfig().BUSINESS_TIME_ZONE || BUSINESS_TIME_ZONE;
    const now = new Date();
    const act = await this.prisma.client.act.findFirst({
      where: scope.actVisibleWhere(actId),
      select: {
        id: true,
        formCode: true,
        officialNumber: true,
        status: true,
        createdAt: true,
        cancelledAt: true,
        cancellationReason: true,
        signedDocumentRef: true,
        propertyObject: {
          select: {
            name: true,
            address: true,
            commissionedAt: true,
            warrantyEndsAt: true,
          },
        },
        customer: { select: { officialName: true } },
        defectItems: {
          where: scope.defectItemsOnActWhere(actId),
          orderBy: [{ location: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            location: true,
            status: true,
            plannedDeadline: true,
            claimDeadline: true,
            readyAt: true,
            thirdPartyDeadline: true,
            notes: true,
            defectType: { select: { name: true } },
            responsibleEngineers: {
              select: { user: { select: { id: true, fullName: true } } },
              orderBy: { user: { fullName: 'asc' } },
            },
            liableOrganizations: {
              select: { organization: { select: { id: true, officialName: true } } },
              orderBy: { organization: { officialName: 'asc' } },
            },
            proposals: {
              where: { slot: { in: visibleProposalSlots(user.role) } },
              select: {
                slot: true,
                amount: true,
                currency: true,
                alternativeContractor: { select: { officialName: true } },
              },
            },
          },
        },
      },
    });
    if (!act || act.defectItems.length === 0) {
      throw new NotFoundException('Запись не найдена');
    }
    const defectItems: ActDetailDefectItem[] = act.defectItems.map((item) => {
      const proposals = shapeProposals(
        item.proposals.map((proposal) => ({
          slot: proposal.slot,
          amount: proposal.amount,
          currency: proposal.currency,
          contractorName: proposal.alternativeContractor.officialName,
        })),
        user.role,
      );
      const deadlineState = deadlineStateOf({
        status: item.status,
        plannedDeadline: item.plannedDeadline,
        claimDeadline: item.claimDeadline,
        deadlineWarningDays: warningDays,
        now,
        timeZone,
      });
      return {
        id: item.id,
        location: item.location,
        defectTypeName: item.defectType.name,
        status: item.status,
        statusLabel: defectItemStatusLabel(item.status),
        responsibleEngineers: item.responsibleEngineers.map((entry) => ({
          id: entry.user.id,
          fullName: entry.user.fullName,
        })),
        liableOrganizations: item.liableOrganizations.map((entry) => ({
          id: entry.organization.id,
          name: entry.organization.officialName,
        })),
        plannedDeadline: calendarField(item.plannedDeadline, timeZone),
        claimDeadline: calendarField(item.claimDeadline, timeZone),
        effectiveDeadline: calendarField(
          effectiveDeadlineOf({
            plannedDeadline: item.plannedDeadline,
            claimDeadline: item.claimDeadline,
          }),
          timeZone,
        ),
        deadlineState,
        deadlineStateLabel: deadlineStateLabel(deadlineState),
        readyAt: timestampField(item.readyAt),
        thirdPartyDeadline: calendarField(item.thirdPartyDeadline, timeZone),
        notes: item.notes,
        ...proposals,
      };
    });
    return {
      ...toActHeader(act),
      defectItems,
    };
  }

  private async prepare(user: AuthenticatedUser, rawQuery: Record<string, unknown>) {
    let query;
    try {
      query = parseRegistryListQuery(normalizeQueryInput(rawQuery));
    } catch (error) {
      if (error instanceof RegistryQueryError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const warningDays = await this.warningDays();
    const timeZone = loadConfig().BUSINESS_TIME_ZONE || BUSINESS_TIME_ZONE;
    const now = new Date();
    return {
      query,
      scope: new RegistryAccessScope(user),
      warningDays,
      timeZone,
      now,
      todayIso: calendarDateInTimeZone(now, timeZone),
    };
  }

  private async warningDays(): Promise<number> {
    const settings = await this.prisma.client.systemSettings.findUnique({
      where: { id: 'default' },
    });
    return settings?.deadlineWarningDays ?? 3;
  }
}

function sortOptions(entries: Array<[string, string]>): Array<{ id: string; label: string }> {
  return entries
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => COLLATOR.compare(left.label, right.label));
}
