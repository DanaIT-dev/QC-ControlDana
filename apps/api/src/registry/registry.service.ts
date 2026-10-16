import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { loadConfig } from '@sgr-registry/config';
import type {
  ActDetailDefectItem,
  ActDetailResponse,
  RegistryFilterOptionsResponse,
  RegistryListResponse,
  RegistrySummaryResponse,
} from '@sgr-registry/contracts';
import { resolveImportedEngineerRequestSchema } from '@sgr-registry/contracts';
import {
  BUSINESS_TIME_ZONE,
  REGISTRY_STATUS_FILTER_OPTIONS,
  calendarDateInTimeZone,
  canResolveImportedEngineer,
  canViewProposalASum,
  deadlineStateLabel,
  deadlineStateOf,
  defectItemStatusLabel,
  effectiveDeadlineOf,
  formLabel,
  formatPersonShort,
  isOversightRole,
  normalizeQueryInput,
  parseRegistryListQuery,
  RegistryQueryError,
  shapeProposals,
  shapeSummary,
  ValidationError,
  visibleProposalSlots,
} from '@sgr-registry/domain';
import { resolveImportedEngineerReference } from '@sgr-registry/database';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { actorContext } from '../common/request-context.js';
import { parseCommandBody } from '../common/command-body.js';
import { resolveRegistryAccessScope } from './registry-access-scope.js';
import {
  deadlineStateWhere,
  personSearchDefectItemIds,
  registryListWhere,
  registryOrderBy,
} from './registry-query-builder.js';
import {
  calendarField,
  registryListSelect,
  timestampField,
  toActHeader,
  toRegistryRow,
} from './registry-serializer.js';

const COLLATOR = new Intl.Collator('ru', { sensitivity: 'base' });

@Injectable()
export class RegistryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    rawQuery: Record<string, unknown>,
  ): Promise<RegistryListResponse> {
    const { query, scope, todayIso, warningDays, now, timeZone, personSearchDefectIds } =
      await this.prepare(user, rawQuery);
    const where = registryListWhere(scope, query, todayIso, warningDays, personSearchDefectIds);
    const [totalCount, actCount] = await Promise.all([
      this.prisma.client.defectItem.count({ where }),
      this.prisma.client.act.count({ where: { defectItems: { some: where } } }),
    ]);
    const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / query.pageSize);
    const page = totalCount === 0 ? 1 : Math.min(query.page, Math.max(totalPages, 1));
    const items = await this.prisma.client.defectItem.findMany({
      where,
      select: {
        ...registryListSelect,
        proposals: {
          ...registryListSelect.proposals,
          where: { slot: { in: visibleProposalSlots(user.role) }, status: 'ACTIVE' },
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
      actCount,
      totalPages,
      appliedSort: { sortBy: query.sortBy, sortDirection: query.sortDirection },
    };
  }

  async summary(
    user: AuthenticatedUser,
    rawQuery: Record<string, unknown>,
  ): Promise<RegistrySummaryResponse> {
    const { query, scope, todayIso, warningDays, personSearchDefectIds } = await this.prepare(
      user,
      rawQuery,
    );
    const where = registryListWhere(scope, query, todayIso, warningDays, personSearchDefectIds);
    const unfinishedDraftRows = await this.prisma.client.act.findMany({
      where: scope.emptyDraftWhere(),
      select: { id: true, officialNumber: true, updatedAt: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 20,
    });
    const [
      total,
      actCount,
      newCount,
      inProgress,
      completed,
      warning,
      overdue,
      noDeadline,
      proposalSum,
    ] = await Promise.all([
      this.prisma.client.defectItem.count({ where }),
      this.prisma.client.act.count({ where: { defectItems: { some: where } } }),
      this.prisma.client.defectItem.count({
        where: { AND: [where, { act: { status: 'NEW' } }] },
      }),
      this.prisma.client.defectItem.count({
        where: {
          AND: [where, { status: 'IN_PROGRESS', act: { status: 'IN_PROGRESS' } }],
        },
      }),
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
            where: { slot: 'A', status: 'ACTIVE', defectItem: where },
          })
        : Promise.resolve(null),
    ]);
    return shapeSummary(
      {
        total,
        actCount,
        newCount,
        inProgress,
        completed,
        warning,
        overdue,
        noDeadline,
        currency: 'BYN',
        deadlineWarningDays: warningDays,
        businessDate: todayIso,
        unfinishedDrafts: unfinishedDraftRows.map((row) => ({
          id: row.id,
          label: row.officialNumber?.trim() || 'Черновик',
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
      user.role,
      proposalSum?._sum.amount ?? '0.00',
    );
  }

  async filterOptions(user: AuthenticatedUser): Promise<RegistryFilterOptionsResponse> {
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
    const itemWhere = scope.defectItemWhere();
    const [formRows, objectRows, defectTypeRows, customerRows, liableRows, engineerRows] =
      await Promise.all([
        this.prisma.client.act.findMany({
          where: { defectItems: { some: itemWhere } },
          distinct: ['formCode'],
          select: { formCode: true },
        }),
        this.prisma.client.propertyObject.findMany({
          where: { acts: { some: { defectItems: { some: itemWhere } } } },
          select: { id: true, name: true, nameSortKey: true },
          orderBy: [{ nameSortKey: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.client.defectType.findMany({
          where: { defectItems: { some: itemWhere } },
          select: { id: true, name: true, nameSortKey: true },
          orderBy: [{ nameSortKey: 'asc' }, { id: 'asc' }],
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
          select: { id: true, lastName: true, firstName: true, middleName: true, fullName: true },
        }),
      ]);

    return {
      formCodes: sortOptions(
        formRows.flatMap((row) =>
          row.formCode ? ([[row.formCode, formLabel(row.formCode)]] as [string, string][]) : [],
        ),
      ),
      statuses: [...REGISTRY_STATUS_FILTER_OPTIONS],
      objects: objectRows.map((row) => ({ id: row.id, label: row.name })),
      defectTypes: defectTypeRows.map((row) => ({ id: row.id, label: row.name })),
      customers: sortOptions(customerRows.map((row) => [row.id, row.officialName])),
      liableOrganizations: sortOptions(liableRows.map((row) => [row.id, row.officialName])),
      responsibleEngineers: engineerRows
        .map((row) => ({
          id: row.id,
          label: formatPersonShort({
            lastName: row.lastName,
            firstName: row.firstName,
            middleName: row.middleName,
          }),
          title: row.fullName,
        }))
        .sort((left, right) => COLLATOR.compare(left.label, right.label)),
    };
  }

  async actDetail(user: AuthenticatedUser, actId: string): Promise<ActDetailResponse> {
    const scope = await resolveRegistryAccessScope(this.prisma.client, user);
    const warningDays = await this.warningDays();
    const timeZone = loadConfig().BUSINESS_TIME_ZONE || BUSINESS_TIME_ZONE;
    const now = new Date();
    const act = await this.prisma.client.act.findFirst({
      where: scope.actVisibleWhere(actId),
      select: {
        id: true,
        formCode: true,
        officialNumber: true,
        sourceActNumberRaw: true,
        sourceStatusRaw: true,
        sourceExternalUrl: true,
        sourceRows: true,
        importedAt: true,
        status: true,
        version: true,
        objectId: true,
        customerOrganizationId: true,
        issuedOn: true,
        createdAt: true,
        updatedAt: true,
        fillingEngineer: {
          select: { id: true, lastName: true, firstName: true, middleName: true, fullName: true },
        },
        startedAt: true,
        startedBy: {
          select: { id: true, lastName: true, firstName: true, middleName: true, fullName: true },
        },
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
            version: true,
            claimDetails: true,
            sourceDeadlineRaw: true,
            plannedDeadline: true,
            claimDeadline: true,
            readyAt: true,
            thirdPartyDeadline: true,
            submittedForInspectionAt: true,
            submissionComment: true,
            rejectedAt: true,
            rejectionReason: true,
            acceptedAt: true,
            submittedBy: { select: { fullName: true } },
            rejectedBy: { select: { fullName: true } },
            acceptedBy: { select: { fullName: true } },
            notes: true,
            defectType: { select: { id: true, name: true } },
            responsibleEngineers: {
              select: {
                user: {
                  select: {
                    id: true,
                    lastName: true,
                    firstName: true,
                    middleName: true,
                    fullName: true,
                  },
                },
              },
              orderBy: { user: { lastName: 'asc' } },
            },
            importedEngineerReferences: {
              where: { resolutionStatus: 'UNMATCHED' },
              select: { id: true, sourceNameRaw: true },
              orderBy: { sourceNameRaw: 'asc' },
            },
            liableOrganizations: {
              select: { organization: { select: { id: true, officialName: true } } },
              orderBy: { organization: { officialName: 'asc' } },
            },
            proposals: {
              where: {
                slot: { in: visibleProposalSlots(user.role) },
                ...(isOversightRole(user.role) ? {} : { status: 'ACTIVE' as const }),
              },
              select: {
                id: true,
                slot: true,
                amount: true,
                currency: true,
                version: true,
                status: true,
                alternativeContractorOrganizationId: true,
                alternativeContractor: { select: { officialName: true } },
              },
            },
          },
        },
      },
    });
    if (!act) {
      throw new NotFoundException('Запись не найдена');
    }
    const defectItems: ActDetailDefectItem[] = act.defectItems.map((item) => {
      const proposals = shapeProposals(
        item.proposals.map((proposal) => ({
          id: proposal.id,
          slot: proposal.slot,
          amount: proposal.amount,
          currency: proposal.currency,
          contractorName: proposal.alternativeContractor.officialName,
          organizationId: proposal.alternativeContractorOrganizationId,
          version: proposal.version,
          status: proposal.status,
        })),
        user.role,
      );
      const deadlineState =
        act.status === 'NEW'
          ? item.plannedDeadline || item.claimDeadline
            ? 'NORMAL'
            : 'NO_DEADLINE'
          : deadlineStateOf({
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
        defectTypeId: item.defectType?.id ?? null,
        defectTypeName: item.defectType?.name ?? null,
        status: item.status,
        statusLabel: defectItemStatusLabel(item.status),
        version: item.version,
        claimDetails: item.claimDetails,
        sourceDeadlineRaw: item.sourceDeadlineRaw,
        responsibleEngineers: [
          ...item.responsibleEngineers.map((entry) => ({
            id: entry.user.id,
            lastName: entry.user.lastName,
            firstName: entry.user.firstName,
            middleName: entry.user.middleName,
            fullName: entry.user.fullName,
            unmatched: false,
          })),
          ...item.importedEngineerReferences.map((entry) => ({
            id: null,
            fullName: entry.sourceNameRaw,
            unmatched: true,
            sourceNameRaw: entry.sourceNameRaw,
            referenceId: entry.id,
          })),
        ],
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
        submittedForInspectionAt: timestampField(item.submittedForInspectionAt),
        submittedByName: item.submittedBy?.fullName ?? null,
        submissionComment: item.submissionComment,
        rejectedAt: timestampField(item.rejectedAt),
        rejectedByName: item.rejectedBy?.fullName ?? null,
        rejectionReason: item.rejectionReason,
        acceptedAt: timestampField(item.acceptedAt),
        acceptedByName: item.acceptedBy?.fullName ?? null,
        notes: item.notes,
        ...proposals,
      };
    });
    return {
      ...toActHeader({
        ...act,
        sourceDeadlineRaws: [
          ...new Set(
            act.defectItems
              .map((item) => item.sourceDeadlineRaw)
              .filter((value): value is string => Boolean(value)),
          ),
        ],
      }),
      defectItems,
    };
  }

  async resolveImportedEngineer(
    user: AuthenticatedUser,
    referenceId: string,
    body: unknown,
    request: import('fastify').FastifyRequest,
  ) {
    if (!canResolveImportedEngineer(user.role)) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const input = parseCommandBody(resolveImportedEngineerRequestSchema, body);
    const ctx = actorContext(user, request);
    try {
      return await this.prisma.client.$transaction(async (tx) => {
        const reference = await tx.importedEngineerReference.findUnique({
          where: { id: referenceId },
          select: { id: true, defectItemId: true },
        });
        if (!reference) {
          throw new NotFoundException('Запись не найдена');
        }
        const visible = await tx.defectItem.findFirst({
          where: {
            id: reference.defectItemId,
            ...(await resolveRegistryAccessScope(this.prisma.client, user)).defectItemWhere(),
          },
          select: { id: true },
        });
        if (!visible) {
          throw new NotFoundException('Запись не найдена');
        }
        return resolveImportedEngineerReference(tx, {
          referenceId,
          matchedUserId: input.userId,
          actorUserId: user.id,
          actorName: user.fullName,
          requestId: ctx.requestId,
          source: 'WEB',
          manual: true,
        });
      });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }
      throw new ValidationError('userId', error instanceof Error ? error.message : 'Ошибка');
    }
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
    const personSearchDefectIds = query.search
      ? await personSearchDefectItemIds(this.prisma.client, query.search)
      : [];
    return {
      query,
      scope: await resolveRegistryAccessScope(this.prisma.client, user),
      warningDays,
      timeZone,
      now,
      todayIso: calendarDateInTimeZone(now, timeZone),
      personSearchDefectIds,
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
