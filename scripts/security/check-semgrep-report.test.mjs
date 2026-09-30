import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = new URL('./check-semgrep-report.mjs', import.meta.url);

function run(report) {
  const dir = mkdtempSync(join(tmpdir(), 'semgrep-report-'));
  const path = join(dir, 'semgrep.json');
  writeFileSync(path, JSON.stringify(report));
  return spawnSync(process.execPath, [checker.pathname, path], { encoding: 'utf8' });
}

test('fails when Semgrep reports a parse error', () => {
  const result = run({
    errors: [{ type: 'PartialParsing', message: 'import() was unexpected' }],
    paths: { scanned: ['packages/contracts/src/notifications.ts'], skipped: [] },
  });
  assert.notEqual(result.status, 0);
});

test('passes when the target file is scanned and there are no errors', () => {
  const result = run({
    errors: [],
    paths: { scanned: ['packages/contracts/src/notifications.ts'], skipped: [] },
    results: [],
  });
  assert.equal(result.status, 0);
});
