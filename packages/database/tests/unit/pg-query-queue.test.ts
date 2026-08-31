import { describe, expect, it } from 'vitest';
import { serializePoolClientQueries } from '../../src/pg-query-queue';

describe('serializePoolClientQueries', () => {
  it('reproduces overlapping query() without a serializer and sequences them with one', async () => {
    const events: string[] = [];
    const unsynchronized = {
      async query(sql: string) {
        events.push(`start:${sql}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        events.push(`end:${sql}`);
        return { rows: [sql] };
      },
    };

    const [first, second] = await Promise.all([
      unsynchronized.query('a'),
      unsynchronized.query('b'),
    ]);
    expect(first).toEqual({ rows: ['a'] });
    expect(second).toEqual({ rows: ['b'] });
    expect(events[1]?.startsWith('start:')).toBe(true);

    events.length = 0;
    const serialized = serializePoolClientQueries({
      async query(sql: string) {
        events.push(`start:${sql}`);
        await new Promise((resolve) => {
          setTimeout(resolve, 20);
        });
        events.push(`end:${sql}`);
        return { rows: [sql] };
      },
    });
    const [left, right] = await Promise.all([serialized.query('a'), serialized.query('b')]);
    expect(left).toEqual({ rows: ['a'] });
    expect(right).toEqual({ rows: ['b'] });
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('keeps wrapping idempotent on the same client', () => {
    const client = { query: async () => ({ rows: [] }) };
    const first = serializePoolClientQueries(client);
    const second = serializePoolClientQueries(client);
    expect(first).toBe(second);
    expect(first).toBe(client);
  });

  it('lets a later query run after the previous query failed', async () => {
    let calls = 0;
    const client = serializePoolClientQueries({
      async query() {
        calls += 1;
        if (calls === 1) {
          throw new Error('first-failed');
        }
        return { rows: [calls] };
      },
    });
    await expect(client.query()).rejects.toThrow('first-failed');
    await expect(client.query()).resolves.toEqual({ rows: [2] });
  });
});
