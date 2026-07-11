import { describe, expect, it } from 'vitest';

// Side effect: populate the error-code registry through the facade, the way
// the package entrypoint does.
import '#/errors';

import { KimiError } from '#/_base/errors/errors';
import { fromErrorPayload, toErrorPayload } from '#/_base/errors/serialize';

describe('toErrorPayload', () => {
  it('passes a coded error through with registry retryability and details', () => {
    const payload = toErrorPayload(
      new KimiError('provider.rate_limit', 'slow down', {
        name: 'APIStatusError',
        details: { statusCode: 429 },
      }),
    );
    expect(payload).toMatchObject({
      code: 'provider.rate_limit',
      message: 'slow down',
      name: 'APIStatusError',
      details: { statusCode: 429 },
      retryable: true,
    });
  });

  it('collapses an uncoded Error to internal', () => {
    const payload = toErrorPayload(new Error('boom'));
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('boom');
  });

  it('stringifies non-error throws', () => {
    expect(toErrorPayload('nope').code).toBe('internal');
    expect(toErrorPayload(undefined).code).toBe('internal');
  });

  it('serializes the cause chain recursively', () => {
    const payload = toErrorPayload(
      new KimiError('provider.api_error', 'translated', {
        cause: new KimiError('provider.connection_error', 'socket reset'),
      }),
    );
    expect(payload.code).toBe('provider.api_error');
    expect(payload.cause).toMatchObject({
      code: 'provider.connection_error',
      message: 'socket reset',
    });
  });

  it('caps cause recursion for pathologically deep chains', () => {
    let error: KimiError | undefined;
    for (let i = 0; i < 20; i += 1) {
      error = new KimiError('internal', `layer ${i}`, error === undefined ? undefined : { cause: error });
    }
    const payload = toErrorPayload(error!);
    let depth = 0;
    let current = payload;
    while (current.cause !== undefined) {
      depth += 1;
      current = current.cause;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });
});

describe('fromErrorPayload', () => {
  it('rehydrates a KimiError with its cause chain', () => {
    const original = new KimiError('provider.api_error', 'outer', {
      details: { statusCode: 500 },
      cause: new KimiError('provider.connection_error', 'inner'),
    });
    const revived = fromErrorPayload(toErrorPayload(original));
    expect(revived).toBeInstanceOf(KimiError);
    expect(revived.code).toBe('provider.api_error');
    expect(revived.details).toMatchObject({ statusCode: 500 });
    expect(revived.cause).toBeInstanceOf(KimiError);
    expect((revived.cause as KimiError).code).toBe('provider.connection_error');
  });
});
