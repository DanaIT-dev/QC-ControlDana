import { describe, expect, it } from 'vitest';
import { actKey, defectItemKey, historyKey, queryKeys } from '../lib/query-keys';

describe('act query-key factory', () => {
  it('keeps a single history key shape for invalidation', () => {
    const actId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
    expect(historyKey(actId)).toEqual(['history', actId]);
    expect(queryKeys.history(actId)).toEqual(historyKey(actId));
    expect(actKey(actId)).toEqual(['act', actId]);
    expect(defectItemKey('cccccccc-cccc-4ccc-8ccc-cccccccccc01')).toEqual([
      'defect',
      'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
    ]);
    expect(queryKeys.registry.all).toEqual(['registry']);
  });
});
