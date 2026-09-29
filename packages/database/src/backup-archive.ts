import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const MAGIC = Buffer.from('SGRB1\0');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;

export function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function assertSafeKeyPath(keyFile: string, outputDirectory: string): void {
  const key = resolve(keyFile);
  const output = resolve(outputDirectory);
  if (key === output || key.startsWith(`${output}${sep}`)) {
    throw new Error('Backup encryption key must not be stored inside the backup directory');
  }
}

function deriveKey(keyFile: string, salt: Buffer): Buffer {
  const secret = readFileSync(keyFile);
  if (secret.length < 16) {
    throw new Error('Backup encryption key file is missing or too short');
  }
  return scryptSync(secret, salt, 32);
}

export function encryptFile(plainPath: string, cipherPath: string, keyFile: string): void {
  assertSafeKeyPath(keyFile, resolve(cipherPath, '..'));
  const plain = readFileSync(plainPath);
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyFile, salt), iv, {
    authTagLength: TAG_LENGTH,
  });
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(cipherPath, Buffer.concat([MAGIC, salt, iv, tag, encrypted]));
}

export function decryptFile(cipherPath: string, plainPath: string, keyFile: string): void {
  assertSafeKeyPath(keyFile, resolve(cipherPath, '..'));
  const payload = readFileSync(cipherPath);
  if (payload.length < HEADER_LENGTH || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Backup payload is not an encrypted archive');
  }
  const salt = payload.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const iv = payload.subarray(MAGIC.length + SALT_LENGTH, MAGIC.length + SALT_LENGTH + IV_LENGTH);
  const tagStart = MAGIC.length + SALT_LENGTH + IV_LENGTH;
  const tag = payload.subarray(tagStart, tagStart + TAG_LENGTH);
  const encrypted = payload.subarray(tagStart + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyFile, salt), iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  writeFileSync(plainPath, Buffer.concat([decipher.update(encrypted), decipher.final()]));
}
