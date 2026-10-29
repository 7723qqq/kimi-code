import { describe, expect, it } from 'bun:test';

import { errorMessage } from '#/errors';

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the message of an Error subclass', () => {
    class Custom extends Error {
      override name = 'Custom';
    }
    expect(errorMessage(new Custom('custom boom'))).toBe('custom boom');
  });

  it('returns an empty string for an Error with an empty message', () => {
    const error = new Error('placeholder');
    error.message = '';
    expect(errorMessage(error)).toBe('');
  });

  it('passes a string through unchanged', () => {
    expect(errorMessage('plain text')).toBe('plain text');
  });

  it('stringifies a non-Error value', () => {
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage({ a: 1 })).toBe('[object Object]');
  });
});
