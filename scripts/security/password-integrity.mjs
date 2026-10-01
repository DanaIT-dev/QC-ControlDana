#!/usr/bin/env node
// Prints only the credential count and an aggregate SHA-256.
// Individual password hashes never leave PostgreSQL.
import { spawnSync } from 'node:child_process';

const database = process.env.SGR_PASSWORD_INTEGRITY_DATABASE ?? 'sgr_registry';
const container = process.env.SGR_POSTGRES_CONTAINER ?? 'sgr-registry-postgres';

if (!/^[a-z0-9_]+$/.test(database)) {
  console.error('Refusing a database name with unexpected characters');
  process.exit(1);
}

const sql = `
SELECT json_build_object(
  'database', current_database(),
  'credentialCount', count(*)::int,
  'fingerprint', encode(
    sha256(convert_to(
      coalesce(string_agg(
        encode(sha256(convert_to("userId"::text || "passwordHash", 'UTF8')), 'hex'),
        E'\\n' ORDER BY "userId"
      ), ''),
      'UTF8'
    )),
    'hex'
  )
)
FROM user_credentials;
`;

const result = spawnSync(
  'docker',
  [
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    'sgr_registry',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-c',
    sql,
  ],
  { encoding: 'utf8' },
);

if (result.error || result.status !== 0) {
  const detail = (result.stderr || result.error?.message || 'psql failed')
    .replace(/password=\S+/gi, 'password=[redacted]')
    .slice(0, 400);
  console.error(detail);
  process.exit(1);
}

const report = JSON.parse(result.stdout);
if (report.database !== database) {
  console.error('unexpected database');
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({
    database: report.database,
    credentialCount: report.credentialCount,
    fingerprint: report.fingerprint,
  })}\n`,
);
