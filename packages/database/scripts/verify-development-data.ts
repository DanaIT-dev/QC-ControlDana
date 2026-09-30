import { createHash } from 'node:crypto';
import { execSql } from '../src/backup-runtime';

const DATABASE = 'sgr_registry';

function rows(sql: string): string[] {
  return execSql(DATABASE, sql)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

const counts = rows(
  `SELECT 'users=' || count(*) FROM users
   UNION ALL SELECT 'acts=' || count(*) FROM acts
   UNION ALL SELECT 'defects=' || count(*) FROM defect_items
   UNION ALL SELECT 'assignments=' || count(*) FROM defect_item_engineers
   UNION ALL SELECT 'unresolved=' || count(*) FROM imported_engineer_references
   UNION ALL SELECT 'organizations=' || count(*) FROM organizations
   UNION ALL SELECT 'objects=' || count(*) FROM property_objects
   UNION ALL SELECT 'audit=' || count(*) FROM audit_logs
   UNION ALL SELECT 'batches=' || count(*) FROM import_batches`,
);

const names = rows(
  `SELECT "role" || '|' || "status" || '|' || "lastName" || '|' || "firstName" || '|' || COALESCE("middleName", '') || '|' || "fullName" || '|' || "sessionVersion"
   FROM users
   ORDER BY "fullName"`,
);
const credentials = rows(`SELECT "passwordHash" FROM user_credentials ORDER BY "userId"`);
const duplicateActs = rows(
  `SELECT "sourceImportKey" FROM acts WHERE "sourceImportKey" IS NOT NULL GROUP BY "sourceImportKey" HAVING count(*) > 1`,
);
const duplicateDefects = rows(
  `SELECT "sourceImportKey" FROM defect_items WHERE "sourceImportKey" IS NOT NULL GROUP BY "sourceImportKey" HAVING count(*) > 1`,
);
const unresolvedNames = rows(
  `SELECT DISTINCT "sourceNameRaw" FROM imported_engineer_references WHERE "resolutionStatus" = 'UNMATCHED' ORDER BY 1`,
);
const ambiguous = names.filter((line) => {
  const parts = line.split('|');
  const middleName = parts[4] ?? '';
  const fullName = parts[5] ?? '';
  return fullName.split(' ').filter(Boolean).length === 2 && middleName.length === 0;
});

const roleCounts = rows(
  `SELECT "role" || '=' || count(*) FROM users GROUP BY "role" ORDER BY "role"`,
);

const report = {
  database: DATABASE,
  counts,
  users: names.map((line) => {
    const [role, status, lastName, firstName, middleName, fullName, sessionVersion] =
      line.split('|');
    return {
      role,
      status,
      lastName,
      firstName,
      middleName: middleName || null,
      fullName,
      sessionVersion,
    };
  }),
  roleCounts,
  passwordFingerprint: fingerprint(credentials.join('\n')),
  credentialCount: credentials.length,
  duplicateActKeys: duplicateActs.length,
  duplicateDefectKeys: duplicateDefects.length,
  unresolvedNames,
  twoTokenNames: ambiguous.map((line) => line.split('|').slice(2, 6).join(' ')),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
