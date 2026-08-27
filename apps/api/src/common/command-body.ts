import { ValidationError, UnknownFieldError, type DomainError } from '@sgr-registry/domain';

type CommandIssue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  keys?: string[];
};

type CommandSchema<T> = {
  safeParse: (
    data: unknown,
  ) => { success: true; data: T } | { success: false; error: { issues: readonly CommandIssue[] } };
};

export function parseCommandBody<T>(schema: CommandSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) {
    return parsed.data;
  }
  const unknownKeys = parsed.error.issues
    .filter((issue) => issue.code === 'unrecognized_keys')
    .flatMap((issue) => issue.keys ?? []);
  if (unknownKeys.length > 0) {
    throw new UnknownFieldError(unknownKeys);
  }
  const first = parsed.error.issues[0];
  const field = first?.path[0] ? String(first.path[0]) : 'body';
  throw new ValidationError(field, first?.message ?? 'Некорректные данные');
}

export function isPrismaUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: string }).code === 'P2002',
  );
}

export function httpStatusForDomainError(error: DomainError): number {
  if (error.code === 'FORBIDDEN_FIELD') {
    return 403;
  }
  return 0;
}
