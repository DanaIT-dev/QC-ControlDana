import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { PASSWORD_MAX_LENGTH, assertPasswordPolicy } from '@sgr-registry/domain';

export async function hashArgon2id(
  password: string,
  options: { memoryCost: number; timeCost: number },
): Promise<string> {
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error('Password exceeds the maximum allowed length');
  }
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
    parallelism: 1,
  });
}

export async function hashPassword(
  password: string,
  options: { memoryCost: number; timeCost: number },
): Promise<string> {
  assertPasswordPolicy(password);
  return hashArgon2id(password, options);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
