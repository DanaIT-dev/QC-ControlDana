import { CSRF_HEADER_NAME } from '@sgr-registry/domain';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly field?: string;
  readonly fields?: Record<string, string>;
  readonly existing?: { id: string; label: string };

  constructor(
    status: number,
    message: string,
    code?: string,
    field?: string,
    existing?: { id: string; label: string },
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.existing = existing;
  }
}

export async function commandFetch<T>(
  path: string,
  input: {
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    csrfToken: string;
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<T> {
  const response = await fetch(path, {
    method: input.method,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      [CSRF_HEADER_NAME]: input.csrfToken,
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify(input.body ?? {}),
  });
  const data = (await response.json().catch(() => null)) as
    | (T & {
        message?: string;
        error?: string;
        field?: string;
        existing?: { id: string; label: string };
      })
    | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.message ?? 'Не удалось выполнить действие',
      data?.error,
      typeof data?.field === 'string' ? data.field : undefined,
      data?.existing && typeof data.existing.id === 'string'
        ? { id: data.existing.id, label: String(data.existing.label ?? '') }
        : undefined,
    );
  }
  return data as T;
}
