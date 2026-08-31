import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';

export const rlsTransactionStorage = new AsyncLocalStorage<Prisma.TransactionClient>();

type TransactionFn = (tx: Prisma.TransactionClient) => Promise<unknown> | unknown;

const DELEGATE_SKIP = new Set(['then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf']);

function isDelegateObject(value: unknown): value is object {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Promise)
  );
}

/**
 * pg connections cannot run concurrent queries. Interactive RLS transactions
 * hold one connection, while services use Promise.all. Queue work on that client.
 */
export function serializeTransactionClient(tx: Prisma.TransactionClient): Prisma.TransactionClient {
  let tail: Promise<unknown> = Promise.resolve();
  const seen = new WeakMap<object, object>();

  const enqueue = (work: () => unknown): Promise<unknown> => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const proxyOf = (source: object): object => {
    const cached = seen.get(source);
    if (cached) {
      return cached;
    }
    const proxy = new Proxy(source, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && DELEGATE_SKIP.has(prop) && !(prop in target)) {
          return undefined;
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value === 'function') {
          return (...args: unknown[]) =>
            enqueue(() => (value as (...inner: unknown[]) => unknown).apply(target, args));
        }
        if (isDelegateObject(value)) {
          return proxyOf(value);
        }
        return value;
      },
    });
    seen.set(source, proxy);
    return proxy;
  };

  return proxyOf(tx) as Prisma.TransactionClient;
}

export function runWithRlsTransaction<T>(
  tx: Prisma.TransactionClient,
  fn: () => Promise<T>,
): Promise<T> {
  return rlsTransactionStorage.run(serializeTransactionClient(tx), fn);
}

export function currentRlsTransaction(): Prisma.TransactionClient | undefined {
  return rlsTransactionStorage.getStore();
}

export function prismaWithRlsTransaction(root: PrismaClient): PrismaClient {
  return new Proxy(root, {
    get(target, prop, receiver) {
      const tx = rlsTransactionStorage.getStore();
      if (prop === '$transaction') {
        if (tx) {
          return async (arg: unknown) => {
            if (typeof arg === 'function') {
              return (arg as TransactionFn)(tx);
            }
            return Promise.all(arg as Array<Promise<unknown>>);
          };
        }
        return Reflect.get(target, prop, receiver) as PrismaClient['$transaction'];
      }
      const source: object = tx ?? target;
      const value = Reflect.get(source, prop, tx ? source : receiver) as unknown;
      if (typeof value === 'function') {
        return value.bind(source);
      }
      return value;
    },
  });
}
