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
import { writeDomainOutbox } from './defect-outbox';
import type { OutboxWriter } from './outbox.writer';

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
    extraRecipientIds: [input.actorUserId],
    body: organizationIncompleteNotificationBody({
      officialName: input.details.officialName,
      missingFields,
      liable: isLiableOrganizationRole(input.roles),
    }),
    organizationId: input.organizationId,
    missingFields: missingFields as OrganizationDetailField[],
  });
  return [outboxId];
}
