import { describe, expect, it } from 'vitest';
import { DOCUMENT_LINK_INVALID, normalizeDocumentRef } from './act-commands';
import { ValidationError } from './errors';

describe('editable document link', () => {
  it('turns empty and whitespace into null and keeps a plain reference', () => {
    expect(normalizeDocumentRef(undefined)).toBeNull();
    expect(normalizeDocumentRef(null)).toBeNull();
    expect(normalizeDocumentRef('')).toBeNull();
    expect(normalizeDocumentRef('   ')).toBeNull();
    expect(normalizeDocumentRef('док-1')).toBe('док-1');
  });

  it('keeps an https URL and rejects other schemes', () => {
    expect(normalizeDocumentRef('https://files.example.sgr.local/act.pdf')).toBe(
      'https://files.example.sgr.local/act.pdf',
    );
    for (const value of [
      'javascript:alert(1)',
      'file:///tmp/act.pdf',
      'data:text/html,hi',
      'http://files.example.sgr.local/act.pdf',
      'https://user:secret@files.example.sgr.local/act.pdf',
    ]) {
      expect(() => normalizeDocumentRef(value)).toThrow(ValidationError);
      try {
        normalizeDocumentRef(value);
      } catch (error) {
        expect(error).toMatchObject({
          field: 'signedDocumentRef',
          message: DOCUMENT_LINK_INVALID,
        });
      }
    }
  });
});
