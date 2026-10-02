import type { Prisma } from '@sgr-registry/database';
import {
  isLiableOrganizationRole,
  missingOrganizationDetailFields,
  organizationDetailsComplete,
  organizationIncompleteNotificationBody,
  organizationIncompleteOccurrenceKey,
  type OrganizationDetailField,
  type OrganizationDetailsInput,
} from '@sgr-registry/domain';
import type { OrganizationRole } from '@sgr-registry/contracts';
import { writeDomainOutbox } from './defect-outbox.js';
import type { OutboxWriter } from './outbox.writer.js';

type OutboxTx = Prisma.TransactionClient;

export async function resolveOrganizationIncompleteNotification(
  tx: OutboxTx,
  organizationId: string,
): Promise<void> {
  const event = await tx.notificationEvent.findUnique({
    where: { occurrenceKey: organizationIncompleteOccurrenceKey(organizationId) },
    select: { id: true },
  });
  if (!event) {
    return;
  }
  await tx.notificationRecipient.updateMany({
    where: { notificationEventId: event.id, revokedAt: null },
    data: { revokedAt: new Date(), archivedAt: new Date() },
  });
}

export async function notifyOrganizationIncomplete(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: {
    organizationId: string;
    details: OrganizationDetailsInput;
    roles?: readonly OrganizationRole[];
    actorUserId: string;
    recipientIds?: string[];
    supplierEntry?: boolean;
  },
): Promise<string[]> {
  if (organizationDetailsComplete(input.details)) {
    await resolveOrganizationIncompleteNotification(tx, input.organizationId);
    return [];
  }
  const occurrenceKey = organizationIncompleteOccurrenceKey(input.organizationId);
  const existing = await tx.notificationEvent.findUnique({
    where: { occurrenceKey },
    include: { recipients: { where: { revokedAt: null }, select: { id: true } } },
  });
  if (existing && existing.recipients.length > 0) {
    return [];
  }
  const missingFields = missingOrganizationDetailFields(input.details);
  const outboxId = await writeDomainOutbox(writer, tx, {
    type: 'ORGANIZATION_DETAILS_INCOMPLETE',
    occurrenceParts: ['ORGANIZATION_DETAILS_INCOMPLETE', input.organizationId],
    actId: null,
    defectItemId: null,
    actorUserId: input.actorUserId,
    automatic: true,
    extraRecipientIds: input.recipientIds ?? [input.actorUserId],
    body: organizationIncompleteNotificationBody({
      officialName: input.details.officialName,
      missingFields,
      liable: isLiableOrganizationRole(input.roles),
      supplierEntry: input.supplierEntry,
    }),
    organizationId: input.organizationId,
    missingFields: missingFields as OrganizationDetailField[],
  });
  return [outboxId];
}

export async function notifyIncompleteWorkSupplier(
  writer: OutboxWriter,
  tx: OutboxTx,
  input: { organizationId: string; actorUserId: string },
): Promise<string[]> {
  const organization = await tx.organization.findUnique({
    where: { id: input.organizationId },
    include: { roles: true },
  });
  if (!organization || !organization.roles.some((row) => row.role === 'ALTERNATIVE_CONTRACTOR')) {
    return [];
  }
  if (organizationDetailsComplete(organization)) {
    await resolveOrganizationIncompleteNotification(tx, organization.id);
    return [];
  }
  const admins = await tx.user.findMany({
    where: { role: 'ADMIN', status: 'ACTIVE' },
    select: { id: true },
  });
  if (admins.length === 0) {
    return [];
  }
  return notifyOrganizationIncomplete(writer, tx, {
    organizationId: organization.id,
    details: organization,
    roles: organization.roles.map((row) => row.role),
    actorUserId: input.actorUserId,
    recipientIds: admins.map((row) => row.id),
    supplierEntry: true,
  });
}
