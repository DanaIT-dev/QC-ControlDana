import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  assertPasswordPolicy,
  isPasswordPolicySatisfied,
  type PasswordPolicyContext,
} from '@sgr-registry/domain';

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
  options: { memoryCost: number; timeCost: number } & PasswordPolicyContext,
): Promise<string> {
  assertPasswordPolicy(password, { email: options.email, fullName: options.fullName });
  return hashArgon2id(password, {
    memoryCost: options.memoryCost,
    timeCost: options.timeCost,
  });
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

const TEMP_PASSWORD_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TEMP_PASSWORD_LOWER = 'abcdefghijkmnopqrstuvwxyz';
const TEMP_PASSWORD_DIGITS = '23456789';
const TEMP_PASSWORD_SPECIAL = '!@#$%^&*-_=+';
const TEMP_PASSWORD_ALL = `${TEMP_PASSWORD_UPPER}${TEMP_PASSWORD_LOWER}${TEMP_PASSWORD_DIGITS}${TEMP_PASSWORD_SPECIAL}`;
export const TEMPORARY_PASSWORD_ALPHABET = TEMP_PASSWORD_ALL;

function pickChar(alphabet: string): string {
  return alphabet[randomInt(0, alphabet.length)]!;
}

export function generateTemporaryPassword(
  length = 16,
  context: PasswordPolicyContext = {},
): string {
  const size = Math.max(length, PASSWORD_MIN_LENGTH, 16);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const chars = [
      pickChar(TEMP_PASSWORD_UPPER),
      pickChar(TEMP_PASSWORD_LOWER),
      pickChar(TEMP_PASSWORD_DIGITS),
      pickChar(TEMP_PASSWORD_SPECIAL),
      ...Array.from({ length: size - 4 }, () => pickChar(TEMP_PASSWORD_ALL)),
    ];
    for (let i = chars.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i + 1);
      const current = chars[i]!;
      chars[i] = chars[j]!;
      chars[j] = current;
    }
    const password = chars.join('');
    if (isPasswordPolicySatisfied(password, context)) {
      return password;
    }
  }
  throw new Error('Unable to generate a compliant temporary password');
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
