import { describe, expect, it } from 'bun:test';

import { retryBackoffDelays, retryErrorFields } from '#/_base/utils/retry';

function codedError(name: string, message: string, code: string): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, { code });
}

function connectionError(cause: unknown): Error {
  const error = new Error('Connection error.');
  error.name = 'APIConnectionError';
  return Object.assign(error, { cause });
}

describe('retryBackoffDelays', () => {
  it('starts at 500 milliseconds and doubles with up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(3);

    expect(delays[0]).toBeGreaterThanOrEqual(500);
    expect(delays[0]).toBeLessThanOrEqual(625);
    expect(delays[1]).toBeGreaterThanOrEqual(1_000);
    expect(delays[1]).toBeLessThanOrEqual(1_250);
  });

  it('caps high-attempt backoff at 32 seconds plus up to 25 percent jitter', () => {
    const delays = retryBackoffDelays(10);

    expect(delays).toHaveLength(9);
    expect(delays[6]).toBeGreaterThanOrEqual(32_000);
    expect(delays[6]).toBeLessThanOrEqual(40_000);
    expect(delays[8]).toBeGreaterThanOrEqual(32_000);
    expect(delays[8]).toBeLessThanOrEqual(40_000);
  });
});

describe('retryErrorFields', () => {
  it('adds the underlying cause the provider SDK drops', () => {
    const error = connectionError(codedError('SocketError', 'other side closed', 'UND_ERR_SOCKET'));

    expect(retryErrorFields(error)).toEqual({
      errorName: 'APIConnectionError',
      errorMessage: 'Connection error. (UND_ERR_SOCKET: other side closed)',
      statusCode: undefined,
    });
  });

  it('walks a nested cause chain in order', () => {
    const socket = codedError('SocketError', 'other side closed', 'UND_ERR_SOCKET');
    const fetchError = Object.assign(new TypeError('fetch failed'), { cause: socket });

    expect(retryErrorFields(connectionError(fetchError)).errorMessage).toBe(
      'Connection error. (TypeError: fetch failed; UND_ERR_SOCKET: other side closed)',
    );
  });

  it('leaves the message untouched when the error carries no cause', () => {
    expect(retryErrorFields(new Error('rate limited')).errorMessage).toBe('rate limited');
  });

  it('does not repeat a cause the message already spells out', () => {
    const error = new Error('Connection error. (TypeError: fetch failed)');

    expect(retryErrorFields(error).errorMessage).toBe(
      'Connection error. (TypeError: fetch failed)',
    );
  });

  it('ignores a cause that only restates the message', () => {
    const error = connectionError(new Error('Connection error.'));

    expect(retryErrorFields(error).errorMessage).toBe('Connection error.');
  });

  it('keeps the status code alongside the cause', () => {
    const error = Object.assign(connectionError(new Error('connect ECONNREFUSED')), {
      statusCode: 502,
    });

    expect(retryErrorFields(error).statusCode).toBe(502);
  });
});
