import { CSRF_HEADER_NAME } from '@sgr-registry/domain';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly field?: string;
  readonly fields?: Record<string, string>;

  constructor(status: number, message: string, code?: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
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
    (T & { message?: string; error?: string; field?: string }) | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.message ?? 'Не удалось выполнить действие',
      data?.error,
      typeof data?.field === 'string' ? data.field : undefined,
    );
  }
  return data as T;
}
