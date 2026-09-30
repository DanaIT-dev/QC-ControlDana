#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('Semgrep report path is required');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const errors = Array.isArray(report.errors) ? report.errors : [];
const scanned = report.paths?.scanned ?? [];
const skipped = report.paths?.skipped ?? [];
const unexpectedSkips = skipped.filter((item) => {
  const path = typeof item === 'string' ? item : (item?.path ?? '');
  return path.endsWith('packages/contracts/src/notifications.ts');
});
const scannedTarget = scanned.some((path) =>
  String(path).endsWith('packages/contracts/src/notifications.ts'),
);

const summary = {
  parseErrors: errors.length,
  scanErrors: errors.length,
  filesScanned: scanned.length,
  unexpectedSkips: unexpectedSkips.length,
  notificationsScanned: scannedTarget,
};
console.log(JSON.stringify(summary));

if (errors.length > 0 || unexpectedSkips.length > 0 || (scanned.length > 0 && !scannedTarget)) {
  process.exit(1);
}
