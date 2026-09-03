import { describe, expect, it } from 'vitest';
import {
  controlTriggerClasses,
  controlTriggerIconClasses,
  controlTriggerValueClasses,
} from '../lib/control-styles';

describe('control-styles', () => {
  it('defines a stable trigger layout contract', () => {
    expect(controlTriggerClasses).toContain('pl-3');
    expect(controlTriggerClasses).toContain('pr-4');
    expect(controlTriggerClasses).toContain('gap-2');
    expect(controlTriggerValueClasses).toContain('truncate');
    expect(controlTriggerValueClasses).toContain('min-w-0');
    expect(controlTriggerIconClasses).toContain('shrink-0');
  });
});
