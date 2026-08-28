import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  NotificationListResponse,
  NotificationSettingsResponse,
  UnreadCountResponse,
} from '@sgr-registry/contracts';
import { notificationSettingsPatchSchema } from '@sgr-registry/contracts';
import type { PrismaClient } from '@sgr-registry/database';
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  StaleWriteError,
  formatDailyEvaluationTime,
  notificationTitle,
  parseDailyEvaluationTime,
  parseNotificationListQuery,
  shapeUnreadCount,
  validateNotificationSettings,
} from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { PRISMA_CLIENT } from '../auth/prisma.tokens';
import { parseCommandBody } from '../common/command-body';
import { actorContext } from '../common/request-context';
import { toJsonValue, writeAuditLog } from '../common/audit-writer';
import { RegistryAccessScope } from '../registry/registry-access-scope';

@Injectable()
export class NotificationsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async list(
    user: AuthenticatedUser,
    query: Record<string, string | undefined>,
  ): Promise<NotificationListResponse> {
    const parsed = parseNotificationListQuery(query);
    const page = parsed.page ?? 1;
    const pageSize = parsed.pageSize ?? DEFAULT_NOTIFICATION_PAGE_SIZE;
    const unreadOnly = parsed.filter === 'unread';
    const scope = this.recipientWhere(user);
    const where = {
      ...scope,
      ...(unreadOnly ? { readAt: null } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.notificationRecipient.count({ where }),
      this.prisma.notificationRecipient.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { event: true },
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => {
        const payload = row.event.payload as { body?: string };
        return {
          id: row.id,
          type: row.event.type as NotificationListResponse['items'][number]['type'],
          title: notificationTitle(
            row.event.type as NotificationListResponse['items'][number]['type'],
          ),
          body:
            payload.body ??
            notificationTitle(row.event.type as NotificationListResponse['items'][number]['type']),
          occurredAt: row.event.occurredAt.toISOString(),
          readAt: row.readAt?.toISOString() ?? null,
          actId: row.event.actId,
          defectItemId: row.event.defectItemId,
        };
      }),
    };
  }

  async unreadCount(user: AuthenticatedUser): Promise<UnreadCountResponse> {
    const count = await this.prisma.notificationRecipient.count({
      where: { ...this.recipientWhere(user), readAt: null },
    });
    return shapeUnreadCount(count);
  }

  async markRead(user: AuthenticatedUser, id: string): Promise<{ ok: true }> {
    const row = await this.prisma.notificationRecipient.findFirst({
      where: { id, ...this.recipientWhere(user) },
    });
    if (!row) {
      throw new NotFoundException('Запись не найдена');
    }
    if (!row.readAt) {
      await this.prisma.notificationRecipient.update({
        where: { id: row.id },
        data: { readAt: new Date() },
      });
      await writeAuditLog(this.prisma, {
        actor: { id: user.id, fullName: user.fullName },
        action: 'NOTIFICATION_READ',
        entityType: 'NOTIFICATION_RECIPIENT',
        entityId: row.id,
        source: 'WEB',
      });
    }
    return { ok: true };
  }

  async readAll(user: AuthenticatedUser): Promise<{ ok: true; count: number }> {
    const result = await this.prisma.notificationRecipient.updateMany({
      where: { ...this.recipientWhere(user), readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count > 0) {
      await writeAuditLog(this.prisma, {
        actor: { id: user.id, fullName: user.fullName },
        action: 'NOTIFICATION_READ_ALL',
        entityType: 'NOTIFICATION_RECIPIENT',
        entityId: user.id,
        newValue: toJsonValue({ count: result.count }),
        source: 'WEB',
      });
    }
    return { ok: true, count: result.count };
  }

  async settings(): Promise<NotificationSettingsResponse> {
    const row = await this.prisma.systemSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', deadlineWarningDays: 3 },
    });
    return {
      version: row.version,
      deadlineWarningDays: row.deadlineWarningDays,
      escalationDays: row.escalationDays,
      dailyEvaluationTime: formatDailyEvaluationTime(row.dailyEvaluationMinuteOfDay),
      emailEnabled: row.emailEnabled,
    };
  }

  async patchSettings(user: AuthenticatedUser, body: unknown, request: FastifyRequest) {
    const input = parseCommandBody(notificationSettingsPatchSchema, body);
    const current = await this.prisma.systemSettings.upsert({
      where: { id: 'default' },
      update: {},
      create: { id: 'default', deadlineWarningDays: 3 },
    });
    if (current.version !== input.expectedVersion) {
      throw new StaleWriteError();
    }
    const next = validateNotificationSettings({
      deadlineWarningDays: input.deadlineWarningDays ?? current.deadlineWarningDays,
      escalationDays: input.escalationDays ?? current.escalationDays,
      dailyEvaluationMinuteOfDay: input.dailyEvaluationTime
        ? parseDailyEvaluationTime(input.dailyEvaluationTime)
        : current.dailyEvaluationMinuteOfDay,
      emailEnabled: input.emailEnabled ?? current.emailEnabled,
    });
    const updated = await this.prisma.systemSettings.updateMany({
      where: { id: 'default', version: input.expectedVersion },
      data: {
        deadlineWarningDays: next.deadlineWarningDays,
        escalationDays: next.escalationDays,
        dailyEvaluationMinuteOfDay: next.dailyEvaluationMinuteOfDay,
        emailEnabled: next.emailEnabled,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new StaleWriteError();
    }
    await writeAuditLog(this.prisma, {
      ...actorContext(user, request),
      action: 'NOTIFICATION_SETTINGS_CHANGED',
      entityType: 'SYSTEM_SETTINGS',
      entityId: 'default',
      oldValue: toJsonValue({
        deadlineWarningDays: current.deadlineWarningDays,
        escalationDays: current.escalationDays,
        dailyEvaluationMinuteOfDay: current.dailyEvaluationMinuteOfDay,
        emailEnabled: current.emailEnabled,
      }),
      newValue: toJsonValue({
        deadlineWarningDays: next.deadlineWarningDays,
        escalationDays: next.escalationDays,
        dailyEvaluationMinuteOfDay: next.dailyEvaluationMinuteOfDay,
        emailEnabled: next.emailEnabled,
      }),
    });
    return this.settings();
  }

  private recipientWhere(user: AuthenticatedUser) {
    const scope = new RegistryAccessScope(user);
    return {
      userId: user.id,
      revokedAt: null,
      event: {
        OR: [
          { defectItem: scope.defectItemWhere() },
          {
            defectItemId: null,
            act: {
              status: { not: 'CANCELLED' as const },
              ...(user.role === 'RESPONSIBLE_ENGINEER'
                ? {
                    defectItems: {
                      some: { responsibleEngineers: { some: { userId: user.id } } },
                    },
                  }
                : {}),
            },
          },
        ],
      },
    };
  }
}
