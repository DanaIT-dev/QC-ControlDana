export function encodeHistoryCursor(row: { occurredAt: Date; id: string }): string {
  return Buffer.from(`${row.occurredAt.toISOString()}|${row.id}`).toString('base64url');
}

export function decodeHistoryCursor(cursor: string): { occurredAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.lastIndexOf('|');
  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const occurredAt = new Date(iso);
  if (!id || Number.isNaN(occurredAt.getTime())) {
    throw new Error('Invalid cursor');
  }
  return { occurredAt, id };
}

export function historyWhereAfter(cursor: { occurredAt: Date; id: string }) {
  return {
    OR: [
      { occurredAt: { lt: cursor.occurredAt } },
      { AND: [{ occurredAt: cursor.occurredAt }, { id: { lt: cursor.id } }] },
    ],
  };
}
