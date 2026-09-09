'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function PersonNameFields({
  idPrefix,
  lastName,
  firstName,
  middleName,
  onLastNameChange,
  onFirstNameChange,
  onMiddleNameChange,
  errors,
  disabled = false,
}: {
  idPrefix: string;
  lastName: string;
  firstName: string;
  middleName: string;
  onLastNameChange: (value: string) => void;
  onFirstNameChange: (value: string) => void;
  onMiddleNameChange: (value: string) => void;
  errors?: Partial<Record<'lastName' | 'firstName' | 'middleName', string>>;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-last-name`}>Фамилия</Label>
        <Input
          id={`${idPrefix}-last-name`}
          value={lastName}
          onChange={(event) => onLastNameChange(event.target.value)}
          required
          disabled={disabled}
          aria-invalid={Boolean(errors?.lastName)}
          className="min-h-11"
        />
        {errors?.lastName ? <p className="text-sm text-destructive">{errors.lastName}</p> : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-first-name`}>Имя</Label>
        <Input
          id={`${idPrefix}-first-name`}
          value={firstName}
          onChange={(event) => onFirstNameChange(event.target.value)}
          required
          disabled={disabled}
          aria-invalid={Boolean(errors?.firstName)}
          className="min-h-11"
        />
        {errors?.firstName ? <p className="text-sm text-destructive">{errors.firstName}</p> : null}
      </div>
      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-middle-name`}>Отчество</Label>
        <Input
          id={`${idPrefix}-middle-name`}
          value={middleName}
          onChange={(event) => onMiddleNameChange(event.target.value)}
          disabled={disabled}
          aria-invalid={Boolean(errors?.middleName)}
          className="min-h-11"
        />
        {errors?.middleName ? (
          <p className="text-sm text-destructive">{errors.middleName}</p>
        ) : null}
      </div>
    </div>
  );
}
