import { afterAll } from 'vitest';
import { assertNoPgQueryDeprecationWarning } from './pg-warning-guard';

afterAll(() => {
  assertNoPgQueryDeprecationWarning();
});
