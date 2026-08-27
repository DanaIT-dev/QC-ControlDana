import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_TOKENS } from '../lib/design-tokens';

describe('design tokens', () => {
  it('exposes the Dana Holding semantic palette', () => {
    expect(DESIGN_TOKENS.background).toBe('#F8FAFC');
    expect(DESIGN_TOKENS.foreground).toBe('#1E293B');
    expect(DESIGN_TOKENS.card).toBe('#FFFFFF');
    expect(DESIGN_TOKENS.mutedForeground).toBe('#64748B');
    expect(DESIGN_TOKENS.brand).toBe('#0087CD');
    expect(DESIGN_TOKENS.primary).toBe('#0070AD');
    expect(DESIGN_TOKENS.accent).toBe('#E0F2FE');
    expect(DESIGN_TOKENS.success).toBe('#DCFCE7');
    expect(DESIGN_TOKENS.successForeground).toBe('#15803D');
    expect(DESIGN_TOKENS.warning).toBe('#FEF9C3');
    expect(DESIGN_TOKENS.warningForeground).toBe('#A16207');
    expect(DESIGN_TOKENS.error).toBe('#FEE2E2');
    expect(DESIGN_TOKENS.errorForeground).toBe('#B91C1C');
  });

  it('keeps globals.css aligned with tokens and does not style checkbox as full-width', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../app/globals.css'), 'utf8');
    expect(css).toContain('--background: #f8fafc');
    expect(css).toContain('--primary: #0070ad');
    expect(css).toContain('--brand: #0087cd');
    expect(css).not.toMatch(/input\s*\{[^}]*width:\s*100%/s);
    expect(css).toContain("input[type='checkbox']");
    expect(css).toContain('max-width: 1.125rem');
  });
});
