import { describe, expect, it } from 'vitest';
import { createActRequestSchema, patchActHeaderRequestSchema } from '@sgr-registry/contracts';

describe('public act document commands', () => {
  it('rejects legacy document fields instead of accepting them', () => {
    expect(
      createActRequestSchema.safeParse({ sourceDocumentUrl: 'https://bitrix.bir.by/doc/1' })
        .success,
    ).toBe(false);
    expect(createActRequestSchema.safeParse({ sourceImportKey: 'LEGACY:1' }).success).toBe(false);
    expect(
      createActRequestSchema.safeParse({ signedDocumentRef: 'https://bitrix.bir.by/doc/1' })
        .success,
    ).toBe(false);
    expect(
      patchActHeaderRequestSchema.safeParse({
        expectedVersion: 1,
        sourceDocumentUrl: 'https://bitrix.bir.by/doc/1',
      }).success,
    ).toBe(false);
    expect(
      patchActHeaderRequestSchema.safeParse({ expectedVersion: 1, sourceImportKey: 'LEGACY:1' })
        .success,
    ).toBe(false);
    expect(
      patchActHeaderRequestSchema.safeParse({ expectedVersion: 1, issuedOn: '2024-04-13' }).success,
    ).toBe(true);
  });
});
