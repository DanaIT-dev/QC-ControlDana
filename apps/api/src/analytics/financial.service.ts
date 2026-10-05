import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { financialImpactWriteSchema, type FinancialImpactList } from '@sgr-registry/contracts';
import {
  convertToByn,
  formatByn,
  hasCapability,
  isCompanyActualCost,
  satisfiesCapability,
  sumMoney,
  ValidationError,
} from '@sgr-registry/domain';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { toJsonValue, writeAuditLog } from '../common/audit-writer.js';
import { parseCommandBody } from '../common/command-body.js';
import { actorContext } from '../common/request-context.js';
import { resolveRegistryAccessScope } from '../registry/registry-access-scope.js';

@Injectable()
export class FinancialImpactService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get prisma() {
    return this.prismaService.client;
  }

  async list(user: AuthenticatedUser, defectItemId: string): Promise<FinancialImpactList> {
    if (!satisfiesCapability(user.role, 'VIEW_FINANCIAL_ANALYTICS')) {
      throw new ForbiddenException('Недостаточно прав');
    }
    await this.requireVisibleDefect(user, defectItemId);
    const items = await this.prisma.defectFinancialImpact.findMany({
      where: { defectItemId },
      orderBy: { occurredAt: 'desc' },
    });
    const confirmed = sumMoney(
      items.map((item) =>
        isCompanyActualCost({
          amountType: item.amountType,
          payerType: item.payerType,
          status: item.status,
          amountByn: item.amountByn.toString(),
        })
          ? item.amountByn.toString()
          : null,
      ),
    );
    return {
      confirmedCompanyCostByn: confirmed,
      headline: formatByn(confirmed),
      canManage: hasCapability(user.role, 'MANAGE_DEFECT_FINANCIALS'),
      items: items.map((item) => ({
        id: item.id,
        defectItemId: item.defectItemId,
        amountType: item.amountType,
        payerType: item.payerType,
        payerOrganizationId: item.payerOrganizationId,
        amountOriginal: item.amountOriginal.toString(),
        currency: item.currency,
        exchangeRateToByn: item.exchangeRateToByn.toString(),
        amountByn: item.amountByn.toString(),
        occurredAt: item.occurredAt.toISOString(),
        status: item.status,
        source: item.source,
        comment: item.comment,
        createdAt: item.createdAt.toISOString(),
        confirmedAt: item.confirmedAt?.toISOString() ?? null,
      })),
    };
  }

  async create(
    user: AuthenticatedUser,
    defectItemId: string,
    body: unknown,
    request: FastifyRequest,
  ) {
    this.requireManage(user);
    await this.requireVisibleDefect(user, defectItemId);
    const input = parseCommandBody(financialImpactWriteSchema, body);
    if (input.payerType === 'LIABLE_ORGANIZATION' && !input.payerOrganizationId) {
      throw new ValidationError('payerOrganizationId', 'Укажите организацию-плательщика');
    }
    const money = convertToByn({
      amountOriginal: input.amountOriginal,
      currency: input.currency,
      exchangeRateToByn: input.exchangeRateToByn,
    });
    const created = await this.prisma.defectFinancialImpact.create({
      data: {
        defectItemId,
        amountType: input.amountType,
        payerType: input.payerType,
        payerOrganizationId: input.payerOrganizationId ?? null,
        amountOriginal: input.amountOriginal,
        currency: money.currency,
        exchangeRateToByn: money.exchangeRateToByn,
        amountByn: money.amountByn,
        occurredAt: new Date(`${input.occurredAt}T12:00:00.000+03:00`),
        status: 'DRAFT',
        source: 'MANUAL',
        comment: input.comment ?? null,
        createdByUserId: user.id,
      },
    });
    await writeAuditLog(this.prisma, {
      ...actorContext(user, request),
      action: 'FINANCIAL_IMPACT_DRAFTED',
      entityType: 'DEFECT_FINANCIAL_IMPACT',
      entityId: created.id,
      parentEntityType: 'DEFECT_ITEM',
      parentEntityId: defectItemId,
      newValue: toJsonValue({
        amountType: created.amountType,
        payerType: created.payerType,
        amountByn: created.amountByn.toString(),
        status: created.status,
      }),
    });
    return { id: created.id, status: created.status };
  }

  async confirm(
    user: AuthenticatedUser,
    defectItemId: string,
    impactId: string,
    request: FastifyRequest,
  ) {
    this.requireManage(user);
    await this.requireVisibleDefect(user, defectItemId);
    const current = await this.prisma.defectFinancialImpact.findFirst({
      where: { id: impactId, defectItemId },
    });
    if (!current) {
      throw new NotFoundException('Запись не найдена');
    }
    if (current.status !== 'DRAFT') {
      throw new ValidationError('status', 'Подтверждать можно только черновик');
    }
    const updated = await this.prisma.defectFinancialImpact.update({
      where: { id: current.id },
      data: {
        status: 'CONFIRMED',
        confirmedByUserId: user.id,
        confirmedAt: new Date(),
      },
    });
    await writeAuditLog(this.prisma, {
      ...actorContext(user, request),
      action: 'FINANCIAL_IMPACT_CONFIRMED',
      entityType: 'DEFECT_FINANCIAL_IMPACT',
      entityId: updated.id,
      parentEntityType: 'DEFECT_ITEM',
      parentEntityId: defectItemId,
      oldValue: toJsonValue({ status: 'DRAFT' }),
      newValue: toJsonValue({ status: 'CONFIRMED', amountByn: updated.amountByn.toString() }),
    });
    return { id: updated.id, status: updated.status };
  }

  async void(
    user: AuthenticatedUser,
    defectItemId: string,
    impactId: string,
    request: FastifyRequest,
  ) {
    this.requireManage(user);
    await this.requireVisibleDefect(user, defectItemId);
    const current = await this.prisma.defectFinancialImpact.findFirst({
      where: { id: impactId, defectItemId },
    });
    if (!current) {
      throw new NotFoundException('Запись не найдена');
    }
    if (current.status !== 'DRAFT') {
      throw new ValidationError(
        'status',
        'Подтверждённую запись нельзя изменить. Добавьте компенсирующую запись',
      );
    }
    const updated = await this.prisma.defectFinancialImpact.update({
      where: { id: current.id },
      data: { status: 'VOIDED', voidedAt: new Date() },
    });
    await writeAuditLog(this.prisma, {
      ...actorContext(user, request),
      action: 'FINANCIAL_IMPACT_VOIDED',
      entityType: 'DEFECT_FINANCIAL_IMPACT',
      entityId: updated.id,
      parentEntityType: 'DEFECT_ITEM',
      parentEntityId: defectItemId,
      oldValue: toJsonValue({ status: 'DRAFT' }),
      newValue: toJsonValue({ status: 'VOIDED' }),
    });
    return { id: updated.id, status: updated.status };
  }

  private requireManage(user: AuthenticatedUser) {
    if (!hasCapability(user.role, 'MANAGE_DEFECT_FINANCIALS')) {
      throw new ForbiddenException('Недостаточно прав');
    }
  }

  private async requireVisibleDefect(user: AuthenticatedUser, defectItemId: string) {
    const scope = await resolveRegistryAccessScope(this.prisma, user);
    const defect = await this.prisma.defectItem.findFirst({
      where: { id: defectItemId, AND: [scope.defectItemWhere()] },
      select: { id: true },
    });
    if (!defect) {
      throw new NotFoundException('Запись не найдена');
    }
  }
}
