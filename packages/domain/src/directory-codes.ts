import { foldKey } from './text';

export function generateCodedReferenceCode(
  prefix: 'WT' | 'DT',
  name: string,
  existingCodes: readonly string[],
  sortOrder: number,
): string {
  const taken = new Set(existingCodes.map((item) => foldKey(item)));
  const slug = foldKey(name)
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12)
    .toUpperCase();
  const order = String(Math.max(1, sortOrder)).padStart(3, '0');
  const candidates = [
    `${prefix}_${order}_${slug || 'X'}`,
    `${prefix}_${order}_${slug || 'X'}2`,
    `${prefix}_${order}_${Date.now().toString(36).toUpperCase()}`,
  ];
  for (const candidate of candidates) {
    const code = candidate.slice(0, 40);
    if (!taken.has(foldKey(code))) {
      return code;
    }
  }
  return `${prefix}_${order}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`.slice(0, 40);
}
