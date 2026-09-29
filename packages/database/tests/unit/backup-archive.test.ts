import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptFile, encryptFile, sha256File } from '../../src/backup-archive';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('backup archive encryption', () => {
  it('round-trips a payload and rejects a tampered ciphertext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sgr-backup-archive-'));
    directories.push(root);
    const keyDirectory = join(root, 'keys');
    const backupDirectory = join(root, 'backups');
    await writeFile(join(root, 'plain.txt'), 'restore-me');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(keyDirectory);
    await mkdir(backupDirectory);
    const keyFile = join(keyDirectory, 'backup.key');
    await writeFile(keyFile, 'backup-key-material-not-in-git');
    const cipher = join(backupDirectory, 'payload.enc');
    encryptFile(join(root, 'plain.txt'), cipher, keyFile);
    const restored = join(root, 'restored.txt');
    decryptFile(cipher, restored, keyFile);
    expect(await readFile(restored, 'utf8')).toBe('restore-me');
    expect(await sha256File(cipher)).toMatch(/^[a-f0-9]{64}$/);

    const bytes = await readFile(cipher);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(cipher, bytes);
    expect(() => decryptFile(cipher, join(root, 'bad.txt'), keyFile)).toThrow();
    expect(() =>
      encryptFile(join(root, 'plain.txt'), join(keyDirectory, 'nested.enc'), keyFile),
    ).toThrow(/must not be stored inside the backup directory/);
  });
});
