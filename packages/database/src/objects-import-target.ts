import { databaseNameOf, isLoopbackHost, postgresHostOf } from './database-url';

export class ObjectsImportTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectsImportTargetError';
  }
}

export function assertObjectsImportDatabaseTarget(input: {
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
    if (!input.confirmProduction) {
      throw new ObjectsImportTargetError(
        'Production import requires --confirm-production and the exact database name.',
      );
    }
    if (!input.apply) {
      throw new ObjectsImportTargetError(
        'Production dry-run is not enabled without an explicit apply path.',
      );
    }
    if (input.confirmDatabase !== databaseName || input.confirmEnv !== databaseName) {
      throw new ObjectsImportTargetError(
        'Set SGR_OBJECTS_IMPORT_CONFIRM and --confirm-database to the exact production database name.',
      );
    }
    return { databaseName, host };
  }

  if (!isLoopbackHost(host)) {
    throw new ObjectsImportTargetError(
      `Refusing to use host "${host}". Objects import is limited to localhost.`,
    );
  }

  if (input.nodeEnv === 'test' || databaseName.endsWith('_test')) {
    if (input.nodeEnv === 'production' || !databaseName.endsWith('_test')) {
      throw new ObjectsImportTargetError('Test import must target a *_test database.');
    }
    if (input.apply && input.confirmDatabase !== databaseName) {
      throw new ObjectsImportTargetError(
        'Test apply requires --confirm-database matching the test database name.',
      );
    }
    return { databaseName, host };
  }

  if (input.nodeEnv !== 'development') {
    throw new ObjectsImportTargetError(
      `Refusing objects import because NODE_ENV="${input.nodeEnv}" is not development.`,
    );
  }
  if (databaseName !== 'sgr_registry') {
    throw new ObjectsImportTargetError(
      `Refusing objects import because database "${databaseName}" is not sgr_registry.`,
    );
  }
  if (input.apply) {
    if (input.confirmDatabase !== 'sgr_registry') {
      throw new ObjectsImportTargetError('Local apply requires --confirm-database=sgr_registry.');
    }
    if (input.confirmEnv !== 'sgr_registry' && !input.stdinIsTty) {
      throw new ObjectsImportTargetError(
        'Set SGR_OBJECTS_IMPORT_CONFIRM=sgr_registry or confirm from an interactive terminal.',
      );
    }
  }
  return { databaseName, host };
}
