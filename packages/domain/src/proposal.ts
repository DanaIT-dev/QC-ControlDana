import type { ProposalSlot } from '@sgr-registry/contracts';
import { DuplicateProposalSlotError, ValidationError } from './errors';

export type ProposalLifecycle = 'ACTIVE' | 'ARCHIVED';

export interface ProposalRef {
  defectItemId: string;
  slot: ProposalSlot;
  status?: ProposalLifecycle;
}

export function assertUniqueProposalSlots(proposals: readonly ProposalRef[]): void {
  const used = new Map<string, Set<ProposalSlot>>();

  for (const proposal of proposals) {
    if (proposal.status === 'ARCHIVED') {
      continue;
    }
    const slots = used.get(proposal.defectItemId) ?? new Set<ProposalSlot>();
    if (slots.has(proposal.slot)) {
      throw new DuplicateProposalSlotError(proposal.slot);
    }
    slots.add(proposal.slot);
    used.set(proposal.defectItemId, slots);
  }
}

export function canAddProposalSlot(existing: readonly ProposalRef[], next: ProposalRef): boolean {
  return !existing.some(
    (proposal) =>
      proposal.defectItemId === next.defectItemId &&
      proposal.slot === next.slot &&
      (proposal.status ?? 'ACTIVE') === 'ACTIVE',
  );
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export function parseProposalAmount(value: unknown): string {
  if (typeof value !== 'string' || !AMOUNT_PATTERN.test(value)) {
    throw new ValidationError('amount', 'Сумма должна быть неотрицательным десятичным числом');
  }
  const parts = value.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const normalized = `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
  if (Number.parseInt(whole, 10) > 9_999_999_999_99) {
    throw new ValidationError('amount', 'Сумма превышает допустимый предел');
  }
  return normalized;
}

export function isProposalAmountExact(value: string): boolean {
  try {
    return parseProposalAmount(value) === (value.includes('.') ? value : `${value}.00`);
  } catch {
    return false;
  }
}

export function formatProposalMoney(amount: string, currency = 'BYN'): string {
  const normalized = parseProposalAmount(amount);
  const [whole = '0', fraction = '00'] = normalized.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped},${fraction} ${currency}`;
}
