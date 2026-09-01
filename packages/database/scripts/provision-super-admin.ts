import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from '@sgr-registry/config';
import {
  assertPasswordPolicy,
  normalizeUserEmail,
  normalizeUserFullName,
} from '@sgr-registry/domain';
import {
  createOwnerPrismaClient,
  databaseNameOf,
  listActiveSuperAdmins,
  provisionSuperAdmin,
  revokeUserRedisSessions,
} from '../src/index';

const repoRoot = resolve(__dirname, '../../..');
const envFile = existsSync(resolve(repoRoot, '.env'))
  ? resolve(repoRoot, '.env')
  : resolve(repoRoot, '.env.example');
loadDotenv({ path: envFile, override: false });

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await new Promise((resolvePrompt) => {
      rl.question(question, (answer) => resolvePrompt(answer));
    });
  } finally {
    rl.close();
  }
}

async function promptHidden(question: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error('Password must be entered from an interactive terminal');
  }
  stdout.write(question);
  const chunks: string[] = [];
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolveHidden, reject) => {
    const onData = (buffer: Buffer) => {
      const char = buffer.toString('utf8');
      if (char === '\n' || char === '\r') {
        cleanup();
        stdout.write('\n');
        resolveHidden(chunks.join(''));
        return;
      }
      if (char === '\u0003') {
        cleanup();
        reject(new Error('cancelled'));
        return;
      }
      if (char === '\u007f' || char === '\b') {
        chunks.pop();
        return;
      }
      chunks.push(char);
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const databaseName = databaseNameOf(config.MIGRATION_DATABASE_URL);
  const requiresConfirm = config.NODE_ENV === 'production' || !databaseName.endsWith('_test');
  if (requiresConfirm && process.env.SGR_SUPER_ADMIN_PROVISION_CONFIRM !== databaseName) {
    throw new Error(
      'Set SGR_SUPER_ADMIN_PROVISION_CONFIRM to the exact target database name before provisioning SUPER_ADMIN.',
    );
  }

  if (argValue('password') || process.env.SGR_SUPER_ADMIN_PASSWORD) {
    throw new Error(
      'Password must be entered from a masked interactive prompt, not arguments or env.',
    );
  }

  const email = normalizeUserEmail(argValue('email') ?? (await prompt('Email: ')));
  const fullName = normalizeUserFullName(
    argValue('full-name') ?? (await prompt('Full name: ')) ?? 'Суперадминистратор',
  );
  const password = await promptHidden('Password: ');
  assertPasswordPolicy(password, { email, fullName });
  const replace = hasFlag('replace');

  const owner = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
  try {
    const active = await listActiveSuperAdmins(owner);
    if (active.length > 1) {
      throw new Error('Unexpected number of active SUPER_ADMIN rows; refusing to continue.');
    }
    const current = active[0];
    let replaceConfirmEmail: string | undefined;
    if (current && current.email !== email) {
      if (!replace) {
        throw new Error(
          'An active SUPER_ADMIN already exists. Re-run with --replace after confirmation.',
        );
      }
      if (!stdin.isTTY) {
        throw new Error('Replacement confirmation must be entered from an interactive terminal');
      }
      stdout.write(`Active SUPER_ADMIN to archive: ${current.email}\n`);
      const typed = (await prompt('Type that email to confirm replacement: ')).trim().toLowerCase();
      if (typed !== current.email) {
        throw new Error('Replacement confirmation does not match the active SUPER_ADMIN email.');
      }
      replaceConfirmEmail = current.email;
    }

    const result = await provisionSuperAdmin({
      owner,
      email,
      fullName,
      password,
      replace,
      replaceConfirmEmail,
    });
    if (result.replacedUserId) {
      try {
        await revokeUserRedisSessions({
          redisUrl: config.REDIS_URL,
          prefix: config.REDIS_KEY_PREFIX,
          userId: result.replacedUserId,
        });
      } catch {
        stdout.write(
          'SUPER_ADMIN replaced; Redis session revoke incomplete. sessionVersion bump still applies.\n',
        );
      }
    }
    stdout.write(`SUPER_ADMIN ready for ${result.email}\n`);
  } finally {
    await owner.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'provision failed';
  console.error(message);
  process.exit(1);
});
