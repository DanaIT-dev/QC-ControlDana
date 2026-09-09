import { databaseNameOf, isLoopbackHost, postgresHostOf } from './database-url';

export class ActsImportTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActsImportTargetError';
  }
}

export function assertActsImportDatabaseTarget(input: {
  nodeEnv: string;
  databaseUrl: string;
  apply: boolean;
  confirmDatabase?: string;
  confirmProduction?: boolean;
  confirmEnv?: string;
  stdinIsTty?: boolean;
}): { databaseName: string; host: string } {
  const databaseName = databaseNameOf(input.databaseUrl);
  const host = postgresHostOf(input.databaseUrl);

  if (input.nodeEnv === 'production' || input.confirmProduction) {
    throw new ActsImportTargetError('Production acts import is not enabled.');
  }
  if (/prod/i.test(databaseName) && databaseName !== 'sgr_registry') {
    throw new ActsImportTargetError(
      `Refusing acts import because database "${databaseName}" looks like production.`,
    );
  }
  if (!isLoopbackHost(host)) {
    throw new ActsImportTargetError(
      `Refusing to use host "${host}". Acts import is limited to localhost.`,
    );
  }
  if (input.nodeEnv === 'test' || databaseName.endsWith('_test') || databaseName.endsWith('_e2e')) {
    if (!databaseName.endsWith('_test') && !databaseName.endsWith('_e2e')) {
      throw new ActsImportTargetError('Test import must target a *_test or *_e2e database.');
    }
    if (input.apply && input.confirmDatabase !== databaseName) {
      throw new ActsImportTargetError(
        'Test apply requires --confirm-database matching the test database name.',
      );
    }
    return { databaseName, host };
  }
  if (input.nodeEnv !== 'development') {
    throw new ActsImportTargetError(
      `Refusing acts import because NODE_ENV="${input.nodeEnv}" is not development.`,
    );
  }
  if (databaseName !== 'sgr_registry') {
    throw new ActsImportTargetError(
      `Refusing acts import because database "${databaseName}" is not sgr_registry.`,
    );
  }
  if (input.apply) {
    if (input.confirmDatabase !== 'sgr_registry') {
      throw new ActsImportTargetError('Local apply requires --confirm-database=sgr_registry.');
    }
    if (input.confirmEnv !== 'sgr_registry' && !input.stdinIsTty) {
      throw new ActsImportTargetError(
        'Set SGR_ACTS_IMPORT_CONFIRM=sgr_registry or confirm from an interactive terminal.',
      );
    }
  }
  return { databaseName, host };
}
