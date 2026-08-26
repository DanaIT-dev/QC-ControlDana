export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export class DefectItemCompletionError extends DomainError {
  constructor(message: string) {
    super('DEFECT_ITEM_COMPLETION_INVALID', message);
    this.name = 'DefectItemCompletionError';
  }
}

export class ActNumberImmutableError extends DomainError {
  constructor() {
    super('ACT_NUMBER_IMMUTABLE', 'Official act number cannot be changed after creation');
    this.name = 'ActNumberImmutableError';
  }
}

export class DuplicateProposalSlotError extends DomainError {
  constructor(slot: string) {
    super('DUPLICATE_PROPOSAL_SLOT', `Proposal slot ${slot} is already used for this defect item`);
    this.name = 'DuplicateProposalSlotError';
  }
}

export class UnpConflictError extends DomainError {
  constructor() {
    super('UNP_CONFLICT', 'An organization with the same normalized UNP already exists');
    this.name = 'UnpConflictError';
  }
}

export class ActCancellationError extends DomainError {
  constructor(message: string) {
    super('ACT_CANCELLATION_INVALID', message);
    this.name = 'ActCancellationError';
  }
}
