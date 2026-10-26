import { describe, expect, it } from 'vitest';
import { immutableActIdentityResponse } from '../../src/common/safe-exception.filter';

describe('immutable act identity errors', () => {
  it('maps the database trigger to a conflict with a request id and no SQL', () => {
    const body = immutableActIdentityResponse(
      new Error(
        'Act official number and form identity cannot be changed after creation\nSELECT passwordHash FROM users',
      ),
      'req-identity',
    );
    expect(body).toEqual({
      statusCode: 409,
      error: 'ACT_NUMBER_IMMUTABLE',
      message: 'Номер и форма акта после создания не изменяются',
      requestId: 'req-identity',
    });
    expect(JSON.stringify(body)).not.toMatch(/SELECT|passwordHash/);
  });

  it('leaves unknown errors for the generic handler', () => {
    expect(
      immutableActIdentityResponse(new Error('database unavailable'), 'req-unknown'),
    ).toBeNull();
  });
});
