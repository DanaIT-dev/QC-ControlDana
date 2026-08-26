import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

function hydrateProcessEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath });
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .default('true')
  .transform((value) => value === 'true' || value === '1');

const booleanFalse = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'DATABASE_URL must be a PostgreSQL connection string',
    ),
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine(
      (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
      'REDIS_URL must be a Redis connection string',
    ),
  S3_ENDPOINT: z.string().url('S3_ENDPOINT must be a URL'),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY is required'),
  S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY is required'),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanString,
  TRUST_PROXY: booleanFalse,
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),
  AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  REDIS_KEY_PREFIX: z.string().min(1).default('sgr'),
  ARGON2_MEMORY_COST: z.coerce.number().int().positive().default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
  BUSINESS_TIME_ZONE: z.string().min(1).default('Europe/Minsk'),
});

export type AppConfig = z.infer<typeof envSchema>;

export class MissingConfigurationError extends Error {
  readonly missingKeys: string[];

  constructor(missingKeys: string[], details: string) {
    super(`Application configuration is incomplete: ${details}`);
    this.name = 'MissingConfigurationError';
    this.missingKeys = missingKeys;
  }
}

function collectIssueKeys(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.join('.') || 'root'))];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  if (source === process.env) {
    hydrateProcessEnv();
  }
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const keys = collectIssueKeys(result.error);
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.') || 'root';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new MissingConfigurationError(keys, details);
  }
  return result.data;
}

export function getConfig(): AppConfig {
  return loadConfig();
}
