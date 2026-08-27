import { parseRegistryListQuery } from '@sgr-registry/domain';
import { describe, expect, it } from 'vitest';
import {
  REGISTRY_FILTER_HISTORY_MODE,
  REGISTRY_SEARCH_DRAFT_HISTORY_MODE,
  registryLocation,
  registryNavigation,
  withPageReset,
} from '../lib/registry-url';

const empty = parseRegistryListQuery({});
const northParkId = '11111111-1111-4111-8111-111111111111';

describe('registry URL navigation helper', () => {
  it('pushes a history entry for meaningful filter changes and resets page', () => {
    const current = { ...empty, page: 3 };
    const next = withPageReset({ ...current, objectIds: [northParkId] });
    expect(registryNavigation({ current, next, mode: REGISTRY_FILTER_HISTORY_MODE })).toEqual({
      href: `/registry?objectIds=${northParkId}`,
      method: 'push',
    });
    expect(next.page).toBe(1);
  });

  it('uses replace while search is being typed and skips identical URLs', () => {
    const typed = { ...empty, search: 'север' };
    expect(
      registryNavigation({
        current: empty,
        next: typed,
        mode: REGISTRY_SEARCH_DRAFT_HISTORY_MODE,
      }),
    ).toEqual({
      href: '/registry?search=%D1%81%D0%B5%D0%B2%D0%B5%D1%80',
      method: 'replace',
    });
    expect(
      registryNavigation({
        current: typed,
        next: typed,
        mode: REGISTRY_SEARCH_DRAFT_HISTORY_MODE,
      }),
    ).toBeNull();
  });

  it('pushes reset, chip removal and confirmed search without navigation loops', () => {
    const filtered = { ...empty, objectIds: [northParkId], statuses: ['IN_PROGRESS' as const] };
    expect(registryLocation(filtered)).toContain('objectIds=');
    expect(
      registryNavigation({
        current: filtered,
        next: empty,
        mode: REGISTRY_FILTER_HISTORY_MODE,
      }),
    ).toEqual({ href: '/registry', method: 'push' });

    const chipRemoved = { ...filtered, statuses: [] as typeof filtered.statuses, page: 1 };
    const removed = registryNavigation({
      current: filtered,
      next: chipRemoved,
      mode: REGISTRY_FILTER_HISTORY_MODE,
    });
    expect(removed?.method).toBe('push');
    expect(removed?.href).not.toContain('statuses=');

    const confirmedSearch = registryNavigation({
      current: empty,
      next: { ...empty, search: 'акт', page: 1 },
      mode: REGISTRY_FILTER_HISTORY_MODE,
    });
    expect(confirmedSearch).toEqual({
      href: '/registry?search=%D0%B0%D0%BA%D1%82',
      method: 'push',
    });
    expect(
      registryNavigation({
        current: { ...empty, search: 'акт' },
        next: { ...empty, search: 'акт' },
        mode: REGISTRY_FILTER_HISTORY_MODE,
      }),
    ).toBeNull();
  });
});
