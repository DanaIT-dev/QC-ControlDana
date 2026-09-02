import { databaseNameOf, isLoopbackHost, postgresHostOf } from './database-url';

export class DirectoriesImportTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoriesImportTargetError';
  }
}

export function assertDirectoriesImportDatabaseTarget(input: {
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
    throw new DirectoriesImportTargetError('Production directories import is not enabled.');
  }
  if (!isLoopbackHost(host)) {
    throw new DirectoriesImportTargetError(
      `Refusing to use host "${host}". Directories import is limited to localhost.`,
    );
  }
  if (input.nodeEnv === 'test' || databaseName.endsWith('_test')) {
    if (!databaseName.endsWith('_test')) {
      throw new DirectoriesImportTargetError('Test import must target a *_test database.');
    }
    if (input.apply && input.confirmDatabase !== databaseName) {
      throw new DirectoriesImportTargetError(
        'Test apply requires --confirm-database matching the test database name.',
      );
    }
    return { databaseName, host };
  }
  if (input.nodeEnv !== 'development') {
    throw new DirectoriesImportTargetError(
      `Refusing directories import because NODE_ENV is not development.`,
    );
  }
  if (databaseName !== 'sgr_registry') {
    throw new DirectoriesImportTargetError(
      'Refusing directories import because database is not sgr_registry.',
    );
  }
  if (input.apply) {
    if (input.confirmDatabase !== 'sgr_registry') {
      throw new DirectoriesImportTargetError(
        'Local apply requires --confirm-database=sgr_registry.',
      );
    }
    if (input.confirmEnv !== 'sgr_registry' && !input.stdinIsTty) {
      throw new DirectoriesImportTargetError(
        'Set SGR_DIRECTORIES_IMPORT_CONFIRM=sgr_registry or confirm from an interactive terminal.',
      );
    }
  }
  return { databaseName, host };
}
