import { describe, expect, it } from 'vitest';
import {
  currentRlsTransaction,
  runWithRlsTransaction,
  serializeTransactionClient,
} from '../../src/rls-als';
import type { Prisma } from '@prisma/client';

describe('RLS transaction client serialization', () => {
  it('runs Promise.all queries one after another on the same client', async () => {
    const events: string[] = [];
    let started = 0;
    const mock = {
      act: {
        async findMany() {
          const id = ++started;
          events.push(`start-${id}`);
          await new Promise((resolve) => {
            setTimeout(resolve, 20);
          });
          events.push(`end-${id}`);
          return [id];
        },
      },
    };

    const serialized = serializeTransactionClient(mock as unknown as Prisma.TransactionClient);
    const [first, second] = await Promise.all([
      serialized.act.findMany(),
      serialized.act.findMany(),
    ]);

    expect(first).toEqual([1]);
    expect(second).toEqual([2]);
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('stores the serialized client in ALS', async () => {
    const mock = { marker: true } as unknown as Prisma.TransactionClient;
    await runWithRlsTransaction(mock, async () => {
      expect(currentRlsTransaction()).not.toBe(mock);
      expect(currentRlsTransaction()).toBeTruthy();
    });
  });
});
