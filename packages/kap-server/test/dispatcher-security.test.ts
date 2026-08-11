import { describe, expect, it } from 'vitest';

import { ErrorCodes, Error2 } from '@moonshot-ai/agent-core-v2';
import { assertDispatchableMethod } from '../src/transport/dispatcher';

describe('assertDispatchableMethod', () => {
  it('allows ordinary public methods', () => {
    expect(() => assertDispatchableMethod('session', 'run')).not.toThrow();
    expect(() => assertDispatchableMethod('session', 'list')).not.toThrow();
  });

  it('rejects prototype-chain and object members', () => {
    for (const method of [
      'constructor',
      'prototype',
      '__proto__',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'toLocaleString',
    ]) {
      expect(() => assertDispatchableMethod('session', method)).toThrowError(
        new Error2(ErrorCodes.REQUEST_INVALID, `method not allowed: session.${method}`),
      );
    }
  });

  it('rejects lifecycle/internal methods', () => {
    for (const method of ['dispose', '_serviceBrand', '_register', '_internalThing']) {
      expect(() => assertDispatchableMethod('session', method)).toThrow();
    }
  });
});
