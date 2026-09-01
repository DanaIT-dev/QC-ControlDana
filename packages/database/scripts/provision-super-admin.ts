import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { config as loadDotenv } from 'dotenv';
import argon2 from 'argon2';
import { loadConfig } from '@sgr-registry/config';
import {
  assertPasswordPolicy,
  normalizeUserEmail,
  normalizeUserFullName,
} from '@sgr-registry/domain';
import { createOwnerPrismaClient, databaseNameOf, insertAuditLogRow } from '../src/index';

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
    return await new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
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
  return new Promise((resolve, reject) => {
    const onData = (buffer: Buffer) => {
      const char = buffer.toString('utf8');
      if (char === '\n' || char === '\r') {
        cleanup();
        stdout.write('\n');
        resolve(chunks.join(''));
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
  assertPasswordPolicy(password);
  const replace = hasFlag('replace');

  const owner = createOwnerPrismaClient(config.MIGRATION_DATABASE_URL);
  try {
    const active = await owner.user.findMany({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    });
    const sameEmail = active.find((row) => row.email === email);
    if (active.length > 0 && !sameEmail && !replace) {
      throw new Error(
        'An active SUPER_ADMIN already exists. Re-run with --replace after confirmation.',
      );
    }
    if (active.length > 0 && !sameEmail && replace) {
      await owner.user.updateMany({
        where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
        data: { status: 'ARCHIVED', archivedAt: new Date(), sessionVersion: { increment: 1 } },
      });
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const now = new Date();
    const upserted = sameEmail
      ? await owner.user.update({
          where: { id: sameEmail.id },
          data: {
            fullName,
            passwordHash,
            mustChangePassword: false,
            passwordChangedAt: now,
            sessionVersion: { increment: 1 },
            version: { increment: 1 },
          },
        })
      : await owner.user.create({
          data: {
            fullName,
            email,
            role: 'SUPER_ADMIN',
            status: 'ACTIVE',
            passwordHash,
            mustChangePassword: false,
            passwordChangedAt: now,
          },
        });

    await insertAuditLogRow(owner, {
      actorUserId: null,
      actorName: 'system',
      action: 'SUPER_ADMIN_PROVISIONED',
      entityType: 'USER',
      entityId: upserted.id,
      parentEntityType: null,
      parentEntityId: null,
      oldValue: null,
      newValue: { email: upserted.email, role: 'SUPER_ADMIN' },
      reason: sameEmail ? 'password-rotated' : replace ? 'replaced' : 'created',
      source: 'SYSTEM',
      occurredAt: now,
      ipAddress: null,
      requestId: null,
    });
    stdout.write(`SUPER_ADMIN ready for ${upserted.email}\n`);
  } finally {
    await owner.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'provision failed';
  console.error(message);
  process.exit(1);
});
