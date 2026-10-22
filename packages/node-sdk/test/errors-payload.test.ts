import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  ErrorCodes,
  fromKimiErrorPayload,
  isKimiError,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from '#/index';
import { log } from '#/logging/logger';

afterEach(() => {
  mock.restore();
});

describe('fromKimiErrorPayload', () => {
  it('round-trips a declared code without warning', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {});
    const payload: KimiErrorPayload = {
      code: ErrorCodes.SESSION_NOT_FOUND,
      message: 'no such session',
      retryable: false,
      details: { sessionId: 'ses_1' },
    };

    const error = fromKimiErrorPayload(payload);

    expect(isKimiError(error)).toBe(true);
    expect(error.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
    expect(error.message).toBe('no such session');
    expect(error.details).toEqual({ sessionId: 'ses_1' });
    expect(toKimiErrorPayload(error)).toMatchObject({
      code: ErrorCodes.SESSION_NOT_FOUND,
      message: 'no such session',
      retryable: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('restates an undeclared wire code as internal instead of crashing on re-serialize', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {});
    const payload = {
      code: 'some.future_code',
      message: 'x',
      retryable: true,
    } as unknown as KimiErrorPayload;

    const error = fromKimiErrorPayload(payload);

    expect(error.code).toBe(ErrorCodes.INTERNAL);
    expect(error.message).toBe('x');
    expect(warn).toHaveBeenCalledWith('unknown Kimi error code from wire; restating as internal', {
      code: 'some.future_code',
      message: 'x',
    });
    expect(() => toKimiErrorPayload(error)).not.toThrow();
    expect(toKimiErrorPayload(error)).toMatchObject({
      code: ErrorCodes.INTERNAL,
      message: 'x',
      retryable: false,
    });
  });
});
