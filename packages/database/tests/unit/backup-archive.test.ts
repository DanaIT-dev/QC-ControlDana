import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decryptFile, encryptFile, sha256File } from '../../src/backup-archive';

const MAGIC_LENGTH = 6;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function ivOf(payload: Buffer): Buffer {
  return payload.subarray(MAGIC_LENGTH + SALT_LENGTH, MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH);
}

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
    expect(bytes.subarray(0, MAGIC_LENGTH).toString('utf8')).toBe('SGRB1\0');
    expect(ivOf(bytes).length).toBe(IV_LENGTH);
    expect(ivOf(bytes).equals(Buffer.alloc(IV_LENGTH))).toBe(false);
    expect(
      bytes.subarray(
        MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH,
        MAGIC_LENGTH + SALT_LENGTH + IV_LENGTH + TAG_LENGTH,
      ).length,
    ).toBe(TAG_LENGTH);
    expect(bytes.includes(Buffer.from('backup-key-material-not-in-git'))).toBe(false);
    bytes[bytes.length - 1] ^= 0xff;
    await writeFile(cipher, bytes);
    const tamperedOutput = join(root, 'bad.txt');
    expect(() => decryptFile(cipher, tamperedOutput, keyFile)).toThrow();
    expect(existsSync(tamperedOutput)).toBe(false);
    expect(() =>
      encryptFile(join(root, 'plain.txt'), join(keyDirectory, 'nested.enc'), keyFile),
    ).toThrow(/must not be stored inside the backup directory/);
  });

  it('uses a fresh IV and rejects the wrong key without writing plaintext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sgr-backup-archive-'));
    directories.push(root);
    const { mkdir } = await import('node:fs/promises');
    const keyDirectory = join(root, 'keys');
    const backupDirectory = join(root, 'backups');
    await mkdir(keyDirectory);
    await mkdir(backupDirectory);
    const keyFile = join(keyDirectory, 'backup.key');
    const otherKey = join(keyDirectory, 'other.key');
    await writeFile(keyFile, 'backup-key-material-not-in-git');
    await writeFile(otherKey, 'different-backup-key-material');
    await writeFile(join(root, 'plain.txt'), 'restore-me');
    const first = join(backupDirectory, 'first.enc');
    const second = join(backupDirectory, 'second.enc');
    encryptFile(join(root, 'plain.txt'), first, keyFile);
    encryptFile(join(root, 'plain.txt'), second, keyFile);
    const firstBytes = await readFile(first);
    const secondBytes = await readFile(second);
    expect(ivOf(firstBytes).equals(ivOf(secondBytes))).toBe(false);
    const wrongOutput = join(root, 'wrong.txt');
    expect(() => decryptFile(first, wrongOutput, otherKey)).toThrow();
    expect(existsSync(wrongOutput)).toBe(false);
  });
});
