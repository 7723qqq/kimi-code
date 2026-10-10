import { describe, expect, it } from 'vitest';

// The v2 engine's error-code registry. Imported by relative path on purpose:
// `kosong` and the engine each carry their own copy of this module and no
// shared package can hold one (`kosong` is the frozen legacy kernel, and the
// engine's import-boundary check forbids it from depending on this package).
// The engine's copy is NOT a re-export of `kosong`'s — the two are independent
// copies, which is exactly why the agreement is asserted from outside both
// rather than enforced by a single implementation. Same arrangement as
// `cache-field-parity.test.ts` guarding the OpenAI usage rule.
//
// Scope note: only the registry module is compared. The sibling copies
// (`errors.ts` / `serialize.ts`) cannot be imported here — they resolve their
// own `#/errors` specifier through this package's tsconfig `paths`, which maps
// it onto `kosong`'s `src/errors.ts` and shadows the engine's module. The
// registry is also where the drift that motivated this file actually lived.
import {
  CoreErrors as engineCore,
  errorInfo as engineErrorInfo,
  isErrorCode as engineIsErrorCode,
  registerErrorDomain as engineRegister,
} from '../../agent-core-v2/src/_base/errors/codes';

import {
  CoreErrors as kosongCore,
  errorInfo as kosongErrorInfo,
  isErrorCode as kosongIsErrorCode,
  registerErrorDomain as kosongRegister,
} from '#/errors/codes';

describe('error-code registry agrees across engines', () => {
  it('registers the same core codes', () => {
    expect(kosongCore.codes).toEqual(engineCore.codes);
  });

  it('reports the same membership for a code neither copy registered', () => {
    const unknown = 'no.such_code_here';
    expect(kosongIsErrorCode(unknown)).toBe(false);
    expect(engineIsErrorCode(unknown)).toBe(false);
  });

  it('reports the same membership for a core code both copies registered', () => {
    expect(kosongIsErrorCode('internal')).toBe(true);
    expect(engineIsErrorCode('internal')).toBe(true);
  });

  it('falls back to the raw code as title for an unknown code, on both sides', () => {
    const unknown = 'no.such_code_here';
    expect(kosongErrorInfo(unknown).title).toBe(unknown);
    expect(engineErrorInfo(unknown).title).toBe(unknown);
    expect(kosongErrorInfo(unknown).public).toBe(engineErrorInfo(unknown).public);
    expect(kosongErrorInfo(unknown).retryable).toBe(engineErrorInfo(unknown).retryable);
  });

  it('honors a registered retryable list identically', () => {
    // Registered through each copy's own entry point under a probe code, so the
    // assertion covers the registration path rather than the built-in domains
    // (the engine registers 38 domains; this package owns only the core codes,
    // which is a deliberate difference, not drift).
    const domain = {
      codes: { PARITY_PROBE: 'parity.probe' },
      retryable: ['parity.probe'],
    } as const;
    kosongRegister(domain);
    engineRegister(domain);

    expect(kosongIsErrorCode('parity.probe')).toBe(true);
    expect(engineIsErrorCode('parity.probe')).toBe(true);
    expect(kosongErrorInfo('parity.probe').retryable).toBe(true);
    expect(engineErrorInfo('parity.probe').retryable).toBe(true);
  });
});
