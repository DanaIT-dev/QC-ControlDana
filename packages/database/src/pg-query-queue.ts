const SERIALIZED = Symbol('sgrSerializedPgQueries');

type QueryableClient = {
  query: (...args: never[]) => unknown;
  [SERIALIZED]?: true;
};

function toPromise(value: unknown): Promise<unknown> {
  if (value !== null && typeof value === 'object' && 'then' in value) {
    return value as Promise<unknown>;
  }
  return Promise.resolve(value);
}

/**
 * Serialize query() on one PostgreSQL client. pg@9 forbids concurrent query()
 * on the same connection; Prisma relation includes can emit them.
 * Per-client only: other connections stay concurrent.
 */
export function serializePoolClientQueries<T extends QueryableClient>(client: T): T {
  if (client[SERIALIZED]) {
    return client;
  }
  const originalQuery = client.query.bind(client) as (...args: never[]) => unknown;
  let tail: Promise<unknown> = Promise.resolve();
  const wrapped = (...args: never[]) => {
    const invoke = (): Promise<unknown> => {
      try {
        return toPromise(originalQuery(...args));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const result = tail.then(invoke, invoke);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  client.query = wrapped as T['query'];
  client[SERIALIZED] = true;
  return client;
}

export function isPoolClientQuerySerialized(client: { [SERIALIZED]?: true }): boolean {
  return client[SERIALIZED] === true;
}
