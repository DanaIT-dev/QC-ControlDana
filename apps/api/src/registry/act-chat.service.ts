import { randomUUID } from 'node:crypto';
import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  actChatListQuerySchema,
  actChatMentionCandidatesQuerySchema,
  createActChatMessageRequestSchema,
  type ActChatListResponse,
  type ActChatMentionCandidatesResponse,
  type ActChatMessageDto,
} from '@sgr-registry/contracts';
import { Prisma } from '@sgr-registry/database';
import {
  ACT_CHAT_DEFAULT_PAGE_SIZE,
  ACT_CHAT_MENTION_CANDIDATE_LIMIT,
  CHAT_MENTIONABLE_ROLES,
  ValidationError,
  assertSafeNotificationPayload,
  buildOccurrenceKey,
  chatMentionOccurrenceKey,
  chatMessageSnippet,
  decodeChatCursor,
  displayActNumber,
  dedupeMentionUserIds,
  encodeChatCursor,
  hasCapability,
  isChatMentionableRole,
  mentionRecipientIds,
  notificationTitle,
  normalizeChatBody,
  roleLabel,
  BUSINESS_STAFF_ROLES,
} from '@sgr-registry/domain';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { PrismaService } from '../auth/prisma.tokens.js';
import { toJsonValue, writeAuditLog } from '../common/audit-writer.js';
import { parseCommandBody } from '../common/command-body.js';
import { actorContext } from '../common/request-context.js';
import { resolveRegistryAccessScope } from './registry-access-scope.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MESSAGE_INCLUDE = {
  author: {
    select: {
      id: true,
      lastName: true,
      firstName: true,
      middleName: true,
      fullName: true,
      role: true,
      status: true,
    },
  },
  mentions: {
    include: {
      user: {
        select: { id: true, lastName: true, firstName: true, middleName: true, fullName: true },
      },
    },
  },
} as const;

type MessageRecord = Prisma.ActChatMessageGetPayload<{ include: typeof MESSAGE_INCLUDE }>;

@Injectable()
export class ActChatService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    user: AuthenticatedUser,
    actId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<ActChatListResponse> {
    const act = await this.requireVisibleAct(user, actId);
    const query = parseCommandBody(actChatListQuerySchema, rawQuery);
    const limit = query.limit ?? ACT_CHAT_DEFAULT_PAGE_SIZE;
    const before = decodeChatCursor(query.before);
    const after = decodeChatCursor(query.after);

    if (after) {
      const rows = await this.prisma.client.actChatMessage.findMany({
        where: { actId: act.id, ...cursorWhere(after, 'after') },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: MESSAGE_INCLUDE,
      });
      const overflow = rows.length > limit;
      const page = overflow ? rows.slice(0, limit) : rows;
      return {
        items: page.map(shapeMessage),
        hasOlder: false,
        olderCursor: null,
        newestCursor:
          page.length > 0
            ? cursorOf(page[page.length - 1]!)
            : encodeChatCursor(after.createdAt, after.id),
      };
    }

    const rows = await this.prisma.client.actChatMessage.findMany({
      where: {
        actId: act.id,
        ...(before ? cursorWhere(before, 'before') : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: MESSAGE_INCLUDE,
    });
    const hasOlder = rows.length > limit;
    const page = (hasOlder ? rows.slice(0, limit) : rows).reverse();
    return {
      items: page.map(shapeMessage),
      hasOlder,
      olderCursor: page.length > 0 ? cursorOf(page[0]!) : null,
      newestCursor: page.length > 0 ? cursorOf(page[page.length - 1]!) : null,
    };
  }

  async mentionCandidates(
    user: AuthenticatedUser,
    actId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<ActChatMentionCandidatesResponse> {
    const act = await this.requireVisibleAct(user, actId);
    const query = parseCommandBody(actChatMentionCandidatesQuerySchema, rawQuery);
    const search = query.q?.trim() ?? '';
    const rows = await this.prisma.client.user.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: [...CHAT_MENTIONABLE_ROLES] },
        ...(search.length > 0 ? { fullName: { contains: search, mode: 'insensitive' } } : {}),
        OR: [
          { role: { in: [...BUSINESS_STAFF_ROLES] } },
          {
            role: 'RESPONSIBLE_ENGINEER',
            objectAssignments: {
              some: { propertyObjectId: act.objectId, unassignedAt: null },
            },
          },
        ],
      },
      select: {
        id: true,
        lastName: true,
        firstName: true,
        middleName: true,
        fullName: true,
        role: true,
      },
      orderBy: { fullName: 'asc' },
      take: ACT_CHAT_MENTION_CANDIDATE_LIMIT,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        lastName: row.lastName,
        firstName: row.firstName,
        middleName: row.middleName,
        fullName: row.fullName,
        role: row.role,
        roleLabel: roleLabel(row.role),
      })),
    };
  }

  async create(
    user: AuthenticatedUser,
    actId: string,
    body: unknown,
    request: FastifyRequest,
  ): Promise<ActChatMessageDto> {
    if (!hasCapability(user.role, 'VIEW_ACT_CHAT')) {
      throw new ForbiddenException('Недостаточно прав');
    }
    const act = await this.requireVisibleAct(user, actId);
    const input = parseCommandBody(createActChatMessageRequestSchema, body);
    const text = normalizeChatBody(input.body);
    const requestedMentions = dedupeMentionUserIds(input.mentionedUserIds ?? []);
    const ctx = actorContext(user, request);

    const existing = await this.prisma.client.actChatMessage.findUnique({
      where: {
        authorId_clientMessageId: {
          authorId: user.id,
          clientMessageId: input.clientMessageId,
        },
      },
      include: MESSAGE_INCLUDE,
    });
    if (existing) {
      if (existing.actId !== act.id) {
        throw new ValidationError('clientMessageId', 'Некорректные данные');
      }
      return shapeMessage(existing);
    }

    const allowedMentions = await this.resolveMentionableUsers(act.objectId, requestedMentions);
    const notifyIds = mentionRecipientIds(
      allowedMentions.map((item) => item.id),
      user.id,
    );

    return this.prisma.client.$transaction(async (tx) => {
      const messageId = randomUUID();
      const now = new Date();
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO act_chat_messages (id, "actId", "authorId", body, "clientMessageId", "createdAt")
        VALUES (
          ${messageId}::uuid,
          ${act.id}::uuid,
          ${user.id}::uuid,
          ${text},
          ${input.clientMessageId}::uuid,
          ${now}::timestamptz
        )
        ON CONFLICT ("authorId", "clientMessageId") DO NOTHING
        RETURNING id
      `;

      if (inserted.length === 0) {
        const replay = await tx.actChatMessage.findUnique({
          where: {
            authorId_clientMessageId: {
              authorId: user.id,
              clientMessageId: input.clientMessageId,
            },
          },
          include: MESSAGE_INCLUDE,
        });
        if (!replay || replay.actId !== act.id) {
          throw new ValidationError('clientMessageId', 'Некорректные данные');
        }
        return shapeMessage(replay);
      }

      if (allowedMentions.length > 0) {
        await tx.actChatMention.createMany({
          data: allowedMentions.map((item) => ({
            messageId,
            userId: item.id,
          })),
        });
      }

      const snippet = chatMessageSnippet(text);
      const displayNumber = displayActNumber({
        officialNumber: act.officialNumber,
        sourceActNumberRaw: act.sourceActNumberRaw,
      });
      const mentionBody = `${user.fullName} упомянул вас в обсуждении акта ${displayNumber}: ${snippet}`;
      for (const recipientId of notifyIds) {
        const payload = {
          type: 'ACT_CHAT_MENTION' as const,
          title: notificationTitle('ACT_CHAT_MENTION'),
          body: mentionBody,
          authorName: user.fullName,
          actNumber: displayNumber,
          snippet,
          messageId,
        };
        assertSafeNotificationPayload(payload);
        await tx.notificationEvent.create({
          data: {
            type: 'ACT_CHAT_MENTION',
            occurrenceKey: buildOccurrenceKey(chatMentionOccurrenceKey(messageId, recipientId)),
            actorUserId: user.id,
            actId: act.id,
            payload,
            occurredAt: now,
            recipients: { create: { userId: recipientId } },
          },
        });
      }

      await writeAuditLog(tx, {
        ...ctx,
        action: 'ACT_CHAT_MESSAGE_CREATED',
        entityType: 'ACT_CHAT_MESSAGE',
        entityId: messageId,
        parentEntityType: 'ACT',
        parentEntityId: act.id,
        newValue: toJsonValue({
          authorId: user.id,
          mentionCount: allowedMentions.length,
        }),
      });

      const created = await tx.actChatMessage.findUniqueOrThrow({
        where: { id: messageId },
        include: MESSAGE_INCLUDE,
      });
      return shapeMessage(created);
    });
  }

  private async resolveMentionableUsers(objectId: string, ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.client.user.findMany({
      where: {
        id: { in: ids },
        status: 'ACTIVE',
        role: { in: [...CHAT_MENTIONABLE_ROLES] },
        OR: [
          { role: { in: [...BUSINESS_STAFF_ROLES] } },
          {
            role: 'RESPONSIBLE_ENGINEER',
            objectAssignments: {
              some: { propertyObjectId: objectId, unassignedAt: null },
            },
          },
        ],
      },
      select: {
        id: true,
        lastName: true,
        firstName: true,
        middleName: true,
        fullName: true,
        role: true,
      },
    });
    const allowed = new Map(
      rows.filter((row) => isChatMentionableRole(row.role)).map((row) => [row.id, row]),
    );
    return ids.flatMap((id) => {
      const row = allowed.get(id);
      return row ? [row] : [];
    });
  }

  private async requireVisibleAct(user: AuthenticatedUser, actId: string) {
    if (!UUID_PATTERN.test(actId)) {
      throw new NotFoundException('Запись не найдена');
    }
    const act = await this.prisma.client.act.findFirst({
      where: (await resolveRegistryAccessScope(this.prisma.client, user)).actVisibleWhere(actId),
      select: { id: true, objectId: true, officialNumber: true, sourceActNumberRaw: true },
    });
    if (!act) {
      throw new NotFoundException('Запись не найдена');
    }
    return act;
  }
}

function cursorWhere(
  cursor: { createdAt: Date; id: string },
  direction: 'before' | 'after',
): Prisma.ActChatMessageWhereInput {
  if (direction === 'before') {
    return {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
      ],
    };
  }
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { gt: cursor.id } }] },
    ],
  };
}

function cursorOf(row: { createdAt: Date; id: string }): string {
  return encodeChatCursor(row.createdAt, row.id);
}

function shapeMessage(row: MessageRecord): ActChatMessageDto {
  return {
    id: row.id,
    actId: row.actId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    clientMessageId: row.clientMessageId,
    author: {
      id: row.author.id,
      lastName: row.author.lastName,
      firstName: row.author.firstName,
      middleName: row.author.middleName,
      fullName: row.author.fullName,
      role: row.author.role,
      roleLabel: roleLabel(row.author.role),
      status: row.author.status,
    },
    mentions: row.mentions.map((mention) => ({
      userId: mention.userId,
      fullName: mention.user.fullName,
    })),
  };
}
