import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import {
  databaseNameFromUrl,
  isLoopbackHost,
  isPrivateHostname,
  isWeakSecret,
  passwordFromUrl,
  weakSecretMessage,
} from './production-secrets';
import { REDIS_API_ACL_USER, REDIS_WORKER_ACL_USER, redisUrlIssues } from './redis';

const BOOTSTRAP_DB_USERS = new Set(['sgr_registry', 'postgres']);

function postgresUser(url: string): string {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
}

function hydrateProcessEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const envPath = resolve(dir, '.env');
    if (existsSync(envPath)) {
      const bootstrap =
        !process.env.DATABASE_URL || BOOTSTRAP_DB_USERS.has(postgresUser(process.env.DATABASE_URL));
      loadDotenv({ path: envPath, override: bootstrap });
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

const booleanStringOptional = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true' || value === '1'));

const STORAGE_ALIAS_REMOVAL = '2026-12-31';
const warnedStorageAliases = new Set<string>();

export function resetStorageAliasWarnings(): void {
  warnedStorageAliases.clear();
}

function warnDeprecatedStorageAlias(legacy: string, canonical: string): void {
  if (warnedStorageAliases.has(legacy)) {
    return;
  }
  warnedStorageAliases.add(legacy);
  console.warn(
    `${legacy} is deprecated. Set ${canonical}. This alias will be removed after ${STORAGE_ALIAS_REMOVAL}.`,
  );
}

const booleanFalse = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const postgresUrl = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      `${name} must be a PostgreSQL connection string`,
    );

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    WEB_PORT: z.coerce.number().int().positive().default(3000),
    WEB_ORIGIN: z.url().default('http://localhost:3000'),
    DATABASE_URL: postgresUrl('DATABASE_URL'),
    AUTH_DATABASE_URL: postgresUrl('AUTH_DATABASE_URL'),
    WORKER_DATABASE_URL: postgresUrl('WORKER_DATABASE_URL'),
    MIGRATION_DATABASE_URL: postgresUrl('MIGRATION_DATABASE_URL'),
    RLS_CONTEXT_SECRET: z.string().min(32, 'RLS_CONTEXT_SECRET must be at least 32 characters'),
    REDIS_URL: z
      .string()
      .min(1, 'REDIS_URL is required')
      .refine(
        (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
        'REDIS_URL must be a Redis connection string',
      ),
    WORKER_REDIS_URL: z
      .string()
      .min(1)
      .refine(
        (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
        'WORKER_REDIS_URL must be a Redis connection string',
      )
      .optional(),
    S3_ENDPOINT: z.url('S3_ENDPOINT must be a URL'),
    S3_REGION: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1),
    S3_TEST_BUCKET: z.string().min(1).default('sgr-attachments-test'),
    S3_FORCE_PATH_STYLE: booleanString,
    S3_USE_SSL: booleanStringOptional,
    S3_PRESIGNED_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    S3_MULTIPART_THRESHOLD_BYTES: z.coerce
      .number()
      .int()
      .min(5 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    CLAMD_HOST: z.string().min(1).default('127.0.0.1'),
    CLAMD_PORT: z.coerce.number().int().positive().default(3310),
    ATTACHMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(20 * 1024 * 1024),
    ATTACHMENT_MAX_PER_OWNER: z.coerce.number().int().positive().default(50),
    ATTACHMENT_MAX_PIXELS: z.coerce.number().int().positive().default(40_000_000),
    ATTACHMENT_SCAN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    TRUST_PROXY: booleanFalse,
    SESSION_IDLE_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(12 * 60 * 60),
    SESSION_ABSOLUTE_LIFETIME_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60),
    AUTH_LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    AUTH_LOGIN_IP_MAX_FAILURES: z.coerce.number().int().positive().default(25),
    AUTH_LOGIN_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    REDIS_KEY_PREFIX: z.string().min(1).default('sgr'),
    ARGON2_MEMORY_COST: z.coerce.number().int().positive().default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
    BUSINESS_TIME_ZONE: z.string().min(1).default('Europe/Minsk'),
    EMAIL_ENABLED: booleanString,
    SMTP_HOST: z.string().min(1).default('127.0.0.1'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),
    SMTP_SECURE: booleanFalse,
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(8_000),
    EMAIL_FROM: z.string().min(1).default('sgr-registry@localhost'),
    PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    MAILPIT_API_URL: z.url().default('http://127.0.0.1:8025'),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3002),
    WORKER_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((value, ctx) => {
    const production = value.NODE_ENV === 'production';
    if (
      value.S3_ACCESS_KEY_ID &&
      value.S3_ACCESS_KEY &&
      value.S3_ACCESS_KEY_ID !== value.S3_ACCESS_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'S3_ACCESS_KEY_ID and S3_ACCESS_KEY differ',
      });
    }
    if (
      value.S3_SECRET_ACCESS_KEY &&
      value.S3_SECRET_KEY &&
      value.S3_SECRET_ACCESS_KEY !== value.S3_SECRET_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECRET_ACCESS_KEY'],
        message: 'S3_SECRET_ACCESS_KEY and S3_SECRET_KEY differ',
      });
    }
    if (production && (value.S3_ACCESS_KEY || value.S3_SECRET_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: `Production must set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY. Deprecated aliases are rejected and will be removed after ${STORAGE_ALIAS_REMOVAL}.`,
      });
    }
    if (!value.S3_ACCESS_KEY_ID && value.S3_ACCESS_KEY) {
      if (!production) {
        warnDeprecatedStorageAlias('S3_ACCESS_KEY', 'S3_ACCESS_KEY_ID');
      }
      value.S3_ACCESS_KEY_ID = value.S3_ACCESS_KEY;
    }
    if (!value.S3_SECRET_ACCESS_KEY && value.S3_SECRET_KEY) {
      if (!production) {
        warnDeprecatedStorageAlias('S3_SECRET_KEY', 'S3_SECRET_ACCESS_KEY');
      }
      value.S3_SECRET_ACCESS_KEY = value.S3_SECRET_KEY;
    }
    if (!value.S3_ACCESS_KEY_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_ACCESS_KEY_ID'],
        message: 'S3_ACCESS_KEY_ID is required',
      });
    }
    if (!value.S3_SECRET_ACCESS_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_SECRET_ACCESS_KEY'],
        message: 'S3_SECRET_ACCESS_KEY is required',
      });
    }
    const https = value.S3_ENDPOINT.startsWith('https://');
    if (value.S3_USE_SSL !== undefined && value.S3_USE_SSL !== https) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_USE_SSL'],
        message: 'S3_USE_SSL must match the S3_ENDPOINT scheme',
      });
    }
    if (value.SESSION_IDLE_TIMEOUT_SECONDS > value.SESSION_ABSOLUTE_LIFETIME_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TIMEOUT_SECONDS'],
        message: 'SESSION_IDLE_TIMEOUT_SECONDS must not exceed SESSION_ABSOLUTE_LIFETIME_SECONDS',
      });
    }
    if (value.NODE_ENV === 'production') {
      if (value.SESSION_IDLE_TIMEOUT_SECONDS > 12 * 60 * 60) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_IDLE_TIMEOUT_SECONDS'],
          message: 'production idle timeout must not exceed 12 hours',
        });
      }
      if (value.SESSION_ABSOLUTE_LIFETIME_SECONDS > 7 * 24 * 60 * 60) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_ABSOLUTE_LIFETIME_SECONDS'],
          message: 'production absolute session lifetime must not exceed 7 days',
        });
      }
      if (!value.WEB_ORIGIN.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_ORIGIN'],
          message: 'WEB_ORIGIN must use HTTPS in production',
        });
      }
    }
    if (value.NODE_ENV === 'production') {
      const runtimeUrls: Array<[string, string, string]> = [
        ['DATABASE_URL', value.DATABASE_URL, 'sgr_app_user'],
        ['AUTH_DATABASE_URL', value.AUTH_DATABASE_URL, 'sgr_auth_user'],
        ['WORKER_DATABASE_URL', value.WORKER_DATABASE_URL, 'sgr_worker_user'],
      ];
      for (const [path, url, expected] of runtimeUrls) {
        const user = postgresUser(url);
        if (BOOTSTRAP_DB_USERS.has(user) || user === 'sgr_owner' || user === 'sgr_migrator') {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: `${path} must not use bootstrap, owner, or migrator roles at runtime`,
          });
        }
        if (user && user !== expected) {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: `${path} must use ${expected} in production`,
          });
        }
      }
      const migratorUser = postgresUser(value.MIGRATION_DATABASE_URL);
      if (BOOTSTRAP_DB_USERS.has(migratorUser)) {
        ctx.addIssue({
          code: 'custom',
          path: ['MIGRATION_DATABASE_URL'],
          message: 'MIGRATION_DATABASE_URL must not use the bootstrap superuser',
        });
      }
    }
    const redisApiIssues = redisUrlIssues(value.REDIS_URL, {
      production,
      expectedUsername: production ? REDIS_API_ACL_USER : undefined,
      name: 'REDIS_URL',
    });
    for (const message of redisApiIssues) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message });
    }
    if (production && !value.WORKER_REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['WORKER_REDIS_URL'],
        message: 'WORKER_REDIS_URL is required in production',
      });
    }
    if (value.WORKER_REDIS_URL) {
      const workerIssues = redisUrlIssues(value.WORKER_REDIS_URL, {
        production,
        expectedUsername: production ? REDIS_WORKER_ACL_USER : undefined,
        name: 'WORKER_REDIS_URL',
      });
      for (const message of workerIssues) {
        ctx.addIssue({ code: 'custom', path: ['WORKER_REDIS_URL'], message });
      }
    }
    if (value.NODE_ENV === 'production' && !value.PUBLIC_APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_APP_URL'],
        message: 'PUBLIC_APP_URL must use HTTPS in production',
      });
    }
    if (value.NODE_ENV === 'production') {
      const secretFields: Array<[string, string]> = [
        ['RLS_CONTEXT_SECRET', value.RLS_CONTEXT_SECRET],
        ['S3_ACCESS_KEY_ID', value.S3_ACCESS_KEY_ID ?? ''],
        ['S3_SECRET_ACCESS_KEY', value.S3_SECRET_ACCESS_KEY ?? ''],
        ['SMTP_PASSWORD', value.SMTP_PASSWORD],
      ];
      for (const [path, secret] of secretFields) {
        if (isWeakSecret(secret)) {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: weakSecretMessage(path),
          });
        }
      }
      const databaseUrls = [
        'DATABASE_URL',
        'AUTH_DATABASE_URL',
        'WORKER_DATABASE_URL',
        'MIGRATION_DATABASE_URL',
      ] as const;
      for (const path of databaseUrls) {
        const url = value[path];
        if (isWeakSecret(passwordFromUrl(url))) {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: weakSecretMessage(path),
          });
        }
        const databaseName = databaseNameFromUrl(url);
        if (databaseName.endsWith('_test') || databaseName.endsWith('_e2e')) {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: `${path} must not point at a test or e2e database in production`,
          });
        }
      }
      for (const [path, url] of [
        ['REDIS_URL', value.REDIS_URL],
        ['WORKER_REDIS_URL', value.WORKER_REDIS_URL ?? ''],
      ] as const) {
        if (url && isWeakSecret(passwordFromUrl(url))) {
          ctx.addIssue({
            code: 'custom',
            path: [path],
            message: weakSecretMessage(path),
          });
        }
      }
      if (isLoopbackHost(value.SMTP_HOST)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SMTP_HOST'],
          message: 'SMTP_HOST must not be a loopback or mailpit address in production',
        });
      }
      try {
        const endpoint = new URL(value.S3_ENDPOINT);
        if (isLoopbackHost(endpoint.hostname)) {
          ctx.addIssue({
            code: 'custom',
            path: ['S3_ENDPOINT'],
            message: 'S3_ENDPOINT must not use a loopback address in production',
          });
        } else if (endpoint.protocol !== 'https:' && !isPrivateHostname(endpoint.hostname)) {
          ctx.addIssue({
            code: 'custom',
            path: ['S3_ENDPOINT'],
            message: 'S3_ENDPOINT must use HTTPS outside the private network',
          });
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_ENDPOINT'],
          message: 'S3_ENDPOINT is not a valid URL',
        });
      }
    }
    try {
      const parsed = new URL(value.PUBLIC_APP_URL);
      if (parsed.username || parsed.password) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_APP_URL'],
          message: 'PUBLIC_APP_URL must not contain credentials',
        });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_APP_URL'],
          message: 'PUBLIC_APP_URL must be http or https',
        });
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_APP_URL'],
        message: 'PUBLIC_APP_URL is not a valid URL',
      });
    }
  });

export type AppConfig = Omit<z.infer<typeof envSchema>, 'WORKER_REDIS_URL'> & {
  WORKER_REDIS_URL: string;
};

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
  const parsed = result.data;
  return {
    ...parsed,
    WORKER_REDIS_URL: parsed.WORKER_REDIS_URL ?? parsed.REDIS_URL,
  };
}

export function getConfig(): AppConfig {
  return loadConfig();
}
