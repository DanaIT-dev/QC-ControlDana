import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const repoRoot = resolve(import.meta.dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile });

process.env.NODE_ENV ??= 'test';
process.env.REDIS_KEY_PREFIX ??= 'sgr-test';
process.env.AUTH_LOGIN_WINDOW_SECONDS ??= '60';
