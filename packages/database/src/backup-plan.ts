export const BACKUP_RETENTION = {
  daily: 7,
  weekly: 4,
  monthly: 3,
} as const;

export type BackupClass = keyof typeof BACKUP_RETENTION;

export type BackupRecord = {
  id: string;
  createdAt: string;
  backupClass: BackupClass;
};

export function backupClassFor(date: Date): BackupClass {
  if (date.getUTCDate() === 1) {
    return 'monthly';
  }
  if (date.getUTCDay() === 0) {
    return 'weekly';
  }
  return 'daily';
}

export function selectBackupsToDelete(
  records: BackupRecord[],
  retention: typeof BACKUP_RETENTION = BACKUP_RETENTION,
): string[] {
  const drop: string[] = [];
  for (const backupClass of ['daily', 'weekly', 'monthly'] as const) {
    const group = records
      .filter((record) => record.backupClass === backupClass)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    drop.push(...group.slice(retention[backupClass]).map((record) => record.id));
  }
  return drop;
}
