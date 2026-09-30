import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { loadConfig, MissingConfigurationError } from './env';
import { isWeakSecret, weakSecretMessage } from './production-secrets';

export const PRODUCTION_READINESS_KEYS = [
  'DATABASE_URL',
  'AUTH_DATABASE_URL',
  'WORKER_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'REDIS_URL',
  'WORKER_REDIS_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'RLS_CONTEXT_SECRET',
  'WEB_ORIGIN',
  'PUBLIC_APP_URL',
  'SMTP_HOST',
  'SMTP_PASSWORD',
  'EMAIL_FROM',
  'BACKUP_ENCRYPTION_KEY_FILE',
  'BACKUP_ROOT',
  'TLS_CERT_FILE',
  'TLS_KEY_FILE',
  'SGR_IMAGE_TAG',
  'SGR_RUNTIME_IMAGE_DIGEST',
  'SGR_WEB_IMAGE_DIGEST',
  'SGR_MIGRATOR_IMAGE_DIGEST',
  'SGR_PLATFORM',
] as const;

const GIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PRODUCTION_PLATFORMS = new Set(['linux/amd64', 'linux/arm64']);
const MUTABLE_IMAGE_TAGS = new Set(['latest', 'stable', 'main', 'master']);

export type ProductionReadinessFailure = {
  key: string;
  message: string;
};

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(`${root}${sep}`);
}

export function assessProductionReadiness(source: NodeJS.ProcessEnv): ProductionReadinessFailure[] {
  const failures: ProductionReadinessFailure[] = [];
  const record = (key: string, message: string) => {
    failures.push({ key, message });
  };

  for (const key of PRODUCTION_READINESS_KEYS) {
    if (!source[key] || String(source[key]).trim().length === 0) {
      record(key, `${key} is required for production`);
    }
  }

  try {
    loadConfig({ ...source, NODE_ENV: 'production' });
  } catch (error) {
    if (error instanceof MissingConfigurationError) {
      for (const key of error.missingKeys) {
        record(
          key,
          error.message.split('; ').find((item) => item.startsWith(`${key}:`)) ?? `${key}: invalid`,
        );
      }
    } else {
      record('configuration', 'production configuration is invalid');
    }
  }

  const keyFile = source.BACKUP_ENCRYPTION_KEY_FILE;
  const backupRoot = source.BACKUP_ROOT;
  if (keyFile && backupRoot && fileExists(keyFile) && isInside(backupRoot, keyFile)) {
    record(
      'BACKUP_ENCRYPTION_KEY_FILE',
      'backup encryption key must not be stored inside BACKUP_ROOT',
    );
  }
  if (keyFile && !fileExists(keyFile)) {
    record('BACKUP_ENCRYPTION_KEY_FILE', 'backup encryption key file is missing');
  }
  if (keyFile && fileExists(keyFile)) {
    const raw = statSync(keyFile);
    if (raw.size < 16) {
      record('BACKUP_ENCRYPTION_KEY_FILE', weakSecretMessage('BACKUP_ENCRYPTION_KEY_FILE'));
    }
  }
  if (source.TLS_CERT_FILE && !fileExists(source.TLS_CERT_FILE)) {
    record('TLS_CERT_FILE', 'TLS certificate file is missing');
  }
  if (source.TLS_KEY_FILE && !fileExists(source.TLS_KEY_FILE)) {
    record('TLS_KEY_FILE', 'TLS private key file is missing');
  }
  if (source.S3_ACCESS_KEY && isWeakSecret(source.S3_ACCESS_KEY)) {
    record('S3_ACCESS_KEY', weakSecretMessage('S3_ACCESS_KEY'));
  }
  const imageTag = source.SGR_IMAGE_TAG?.trim() ?? '';
  if (imageTag && (MUTABLE_IMAGE_TAGS.has(imageTag) || !GIT_SHA.test(imageTag))) {
    record('SGR_IMAGE_TAG', 'SGR_IMAGE_TAG must be the full Git commit SHA');
  }
  for (const key of [
    'SGR_RUNTIME_IMAGE_DIGEST',
    'SGR_WEB_IMAGE_DIGEST',
    'SGR_MIGRATOR_IMAGE_DIGEST',
  ] as const) {
    const digest = source[key]?.trim() ?? '';
    if (digest && !IMAGE_DIGEST.test(digest)) {
      record(key, `${key} must be an immutable sha256 digest`);
    }
  }
  const platform = source.SGR_PLATFORM?.trim() ?? '';
  if (platform && !PRODUCTION_PLATFORMS.has(platform)) {
    record('SGR_PLATFORM', 'SGR_PLATFORM must be linux/amd64 or linux/arm64');
  }
  if (source.WEB_ORIGIN && source.PUBLIC_APP_URL) {
    try {
      const origin = new URL(source.WEB_ORIGIN).origin;
      const app = new URL(source.PUBLIC_APP_URL).origin;
      if (origin !== app) {
        record('WEB_ORIGIN', 'WEB_ORIGIN and PUBLIC_APP_URL must share the same origin');
      }
    } catch {
      record('WEB_ORIGIN', 'WEB_ORIGIN or PUBLIC_APP_URL is not a valid URL');
    }
  }

  const seen = new Set<string>();
  return failures.filter((failure) => {
    const id = `${failure.key}:${failure.message}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}
