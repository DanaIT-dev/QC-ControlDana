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

export class ValidationError extends DomainError {
  readonly field: string;

  constructor(field: string, message: string) {
    super('VALIDATION_ERROR', message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export class UnknownFieldError extends DomainError {
  constructor(fields: readonly string[]) {
    super('UNKNOWN_FIELD', `Неизвестные поля: ${fields.join(', ')}`);
    this.name = 'UnknownFieldError';
  }
}

export class StaleWriteError extends DomainError {
  constructor() {
    super('STALE_WRITE', 'Запись изменена другим пользователем. Обновите данные и повторите.');
    this.name = 'StaleWriteError';
  }
}

export class DuplicateValueError extends DomainError {
  constructor(message = 'Такое значение уже существует') {
    super('DUPLICATE_VALUE', message);
    this.name = 'DuplicateValueError';
  }
}

export interface DuplicateDirectoryRecord {
  id: string;
  label: string;
}

export class DuplicateDirectoryRecordError extends DuplicateValueError {
  readonly existing: DuplicateDirectoryRecord;

  constructor(message: string, existing: DuplicateDirectoryRecord) {
    super(message);
    this.name = 'DuplicateDirectoryRecordError';
    this.existing = existing;
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(message = 'Недопустимый переход статуса') {
    super('INVALID_TRANSITION', message);
    this.name = 'InvalidTransitionError';
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_REUSE',
      'Ключ идемпотентности уже использован с другим содержимым запроса',
    );
    this.name = 'IdempotencyConflictError';
  }
}

export class LastAdminProtectedError extends DomainError {
  constructor(message = 'Нельзя архивировать или понизить последнего активного администратора') {
    super('LAST_ADMIN_PROTECTED', message);
    this.name = 'LastAdminProtectedError';
  }
}

export class LastAdminRevokeError extends LastAdminProtectedError {
  constructor() {
    super('Нельзя снять права последнего администратора');
    this.name = 'LastAdminRevokeError';
  }
}

export class AdminGrantNotEligibleError extends DomainError {
  constructor() {
    super('ADMIN_GRANT_INELIGIBLE', 'Нельзя назначить эту учётную запись администратором');
    this.name = 'AdminGrantNotEligibleError';
  }
}

export class SelfAdminGrantError extends DomainError {
  constructor() {
    super('ADMIN_GRANT_INELIGIBLE', 'Нельзя назначить эту учётную запись администратором');
    this.name = 'SelfAdminGrantError';
  }
}

export class AccountProtectedError extends DomainError {
  constructor() {
    super('FORBIDDEN_FIELD', 'Недостаточно прав');
    this.name = 'AccountProtectedError';
  }
}

export class SelfArchiveError extends DomainError {
  constructor() {
    super('SELF_ARCHIVE_FORBIDDEN', 'Нельзя архивировать текущую учётную запись');
    this.name = 'SelfArchiveError';
  }
}

export class ForbiddenFieldError extends DomainError {
  constructor(field: string) {
    super('FORBIDDEN_FIELD', `Недостаточно прав для изменения поля ${field}`);
    this.name = 'ForbiddenFieldError';
  }
}

export class DeadlineReasonRequiredError extends DomainError {
  constructor() {
    super('DEADLINE_REASON_REQUIRED', 'Укажите причину изменения или очистки срока');
    this.name = 'DeadlineReasonRequiredError';
  }
}

export const CONFLICT_ERROR_CODES = new Set([
  'STALE_WRITE',
  'DUPLICATE_PROPOSAL_SLOT',
  'DUPLICATE_VALUE',
  'UNP_CONFLICT',
  'INVALID_TRANSITION',
  'IDEMPOTENCY_KEY_REUSE',
  'LAST_ADMIN_PROTECTED',
  'SELF_ARCHIVE_FORBIDDEN',
  'ACT_NUMBER_IMMUTABLE',
  'DEFECT_ITEM_COMPLETION_INVALID',
  'ACT_CANCELLATION_INVALID',
  'DEADLINE_REASON_REQUIRED',
  'ATTACHMENT_OWNER_XOR',
]);

export const VALIDATION_ERROR_CODES = new Set([
  'VALIDATION_ERROR',
  'PASSWORD_POLICY',
  'UNKNOWN_FIELD',
  'ADMIN_GRANT_INELIGIBLE',
  'UNSAFE_FILENAME',
  'UNSUPPORTED_TYPE',
  'MIME_MISMATCH',
  'EMPTY_FILE',
  'UNSAFE_IMAGE',
  'UNSAFE_OBJECT_KEY',
]);
