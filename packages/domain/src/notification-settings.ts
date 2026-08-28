import { ValidationError } from './errors';
import { DEFAULT_DAILY_EVALUATION_MINUTE, DEFAULT_ESCALATION_DAYS } from './sla';

export interface NotificationSettingsInput {
  deadlineWarningDays: number;
  escalationDays: number[];
  dailyEvaluationMinuteOfDay: number;
  emailEnabled: boolean;
}

export function parseDailyEvaluationTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new ValidationError('dailyEvaluationTime', 'Ожидается время в формате ЧЧ:ММ');
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new ValidationError('dailyEvaluationTime', 'Некорректное время ежедневной проверки');
  }
  return hours * 60 + minutes;
}

export function formatDailyEvaluationTime(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function validateNotificationSettings(
  input: NotificationSettingsInput,
): NotificationSettingsInput {
  if (
    !Number.isInteger(input.deadlineWarningDays) ||
    input.deadlineWarningDays < 1 ||
    input.deadlineWarningDays > 30
  ) {
    throw new ValidationError('deadlineWarningDays', 'Допустимо от 1 до 30 дней');
  }
  if (input.escalationDays.length === 0 || input.escalationDays.length > 8) {
    throw new ValidationError('escalationDays', 'Укажите от 1 до 8 порогов эскалации');
  }
  const unique = [...new Set(input.escalationDays)].sort((a, b) => a - b);
  if (unique.some((day) => !Number.isInteger(day) || day < 0 || day > 365)) {
    throw new ValidationError('escalationDays', 'Пороги эскалации — целые дни от 0 до 365');
  }
  if (unique[0] !== 0) {
    throw new ValidationError('escalationDays', 'Первый порог эскалации должен быть 0');
  }
  if (
    !Number.isInteger(input.dailyEvaluationMinuteOfDay) ||
    input.dailyEvaluationMinuteOfDay < 0 ||
    input.dailyEvaluationMinuteOfDay > 23 * 60 + 59
  ) {
    throw new ValidationError(
      'dailyEvaluationMinuteOfDay',
      'Некорректное время ежедневной проверки',
    );
  }
  return {
    deadlineWarningDays: input.deadlineWarningDays,
    escalationDays: unique,
    dailyEvaluationMinuteOfDay: input.dailyEvaluationMinuteOfDay,
    emailEnabled: input.emailEnabled,
  };
}

export function defaultNotificationSettings(): NotificationSettingsInput {
  return {
    deadlineWarningDays: 3,
    escalationDays: [...DEFAULT_ESCALATION_DAYS],
    dailyEvaluationMinuteOfDay: DEFAULT_DAILY_EVALUATION_MINUTE,
    emailEnabled: true,
  };
}
