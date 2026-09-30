import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assertRestoreDatabaseName,
  readEncryptedBackup,
  writeEncryptedBackup,
} from '../../src/backup-runtime';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('encrypted backup bundle', () => {
  it('refuses to restore over development, test, or e2e databases', () => {
    expect(() => assertRestoreDatabaseName('sgr_registry')).toThrow(/Refusing/);
    expect(() => assertRestoreDatabaseName('sgr_registry_test')).toThrow(/Refusing/);
    expect(() => assertRestoreDatabaseName('sgr_registry_e2e')).toThrow(/Refusing/);
    expect(() => assertRestoreDatabaseName('sgr_restore_drill_dst')).not.toThrow();
  });

  it('restores the dump and object bytes from an encrypted archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sgr-backup-runtime-'));
    directories.push(root);
    const repoRoot = join(root, 'repo');
    const backupRoot = join(root, 'backups');
    const keyFile = join(root, 'keys', 'backup.key');
    await mkdir(repoRoot);
    await mkdir(backupRoot);
    await mkdir(join(root, 'keys'));
    await writeFile(keyFile, 'backup-key-material-not-in-git');
    const body = Buffer.from('object-bytes');
    const dump = Buffer.from('custom-dump');
    const written = await writeEncryptedBackup({
      repoRoot,
      backupRoot,
      keyFile,
      databaseName: 'sgr_restore_drill_src',
      bucket: 'sgr-restore-drill-src-test',
      dump,
      objects: [
        {
          key: 'restore-drill/sample.txt',
          body,
          sha256: createHash('sha256').update(body).digest('hex'),
        },
      ],
      metadata: { purpose: 'unit' },
    });
    const read = await readEncryptedBackup({ directory: written.directory, keyFile });
    expect(read.dump.equals(dump)).toBe(true);
    expect(read.objects).toHaveLength(1);
    expect(read.objects[0]?.body.equals(body)).toBe(true);
    expect(read.manifest.plaintextSha256).toBe(written.manifest.plaintextSha256);
    const manifestText = await readFile(join(written.directory, 'manifest.json'), 'utf8');
    expect(manifestText).not.toContain('backup-key-material-not-in-git');
    expect(existsSync(join(tmpdir(), `sgr-backup-scratch-${basename(written.directory)}`))).toBe(
      false,
    );
    const wrongKey = join(root, 'keys', 'wrong.key');
    await writeFile(wrongKey, 'another-backup-key-material');
    const before = new Set(
      (await readdir(tmpdir())).filter((entry) => entry.startsWith('sgr-backup-read-')),
    );
    await expect(
      readEncryptedBackup({ directory: written.directory, keyFile: wrongKey }),
    ).rejects.toThrow();
    const leftovers = (await readdir(tmpdir())).filter(
      (entry) => entry.startsWith('sgr-backup-read-') && !before.has(entry),
    );
    expect(leftovers).toEqual([]);
  });
});
