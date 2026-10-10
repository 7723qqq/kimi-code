/**
 * Base error classes shared by every domain — `Error2` and related
 * control-flow errors.
 *
 * Shared infrastructure: this package carries its own copy of the module that
 * also lives in agent-core-v2's `_base/errors`. The engine does NOT re-export
 * this file — the two are independent copies (this one keeps `Error2.code` as
 * a plain `string` and uses `t()` for its core messages; the engine's copy
 * narrows the code to its derived `ErrorCode` union and carries no i18n call).
 * They cannot be merged: `kosong` is a frozen legacy kernel and the engine's
 * import-boundary check forbids it from depending on this package. The
 * registry semantics the two copies must share are asserted by
 * `packages/kosong/test/errors-parity.test.ts`.
 */

import { t } from '@moonshot-ai/kimi-i18n';

import { CoreErrors } from './codes';

export class ExpectedError extends Error {
  readonly isExpected = true;
}

export class ErrorNoTelemetry extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CodeExpectedError';
  }

  static fromError(error: Error): ErrorNoTelemetry {
    const wrapped = new ErrorNoTelemetry(error.message);
    wrapped.stack = error.stack;
    return wrapped;
  }

  static isErrorNoTelemetry(error: unknown): error is ErrorNoTelemetry {
    return error instanceof Error && error.name === 'CodeExpectedError';
  }
}

export class BugIndicatingError extends Error {
  constructor(message?: string) {
    super(message ?? t('v2Errors.internal'));
    this.name = 'BugIndicatingError';
  }
}

export interface Error2Options {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly name?: string;
}

export class Error2 extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, options?: Error2Options) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = options?.name ?? 'Error2';
    this.code = code;
    this.details = options?.details;
  }
}

export function isError2(error: unknown): error is Error2 {
  return error instanceof Error2;
}

export function unwrapErrorCause(error: unknown): unknown {
  let current = error;
  while (current instanceof Error2 && current.cause !== undefined) {
    current = current.cause;
  }
  return current;
}

export class NotImplementedError extends Error2 {
  constructor(feature?: string) {
    super(
      CoreErrors.codes.NOT_IMPLEMENTED,
      feature ? `Not implemented: ${feature}` : t('v2Errors.notImplemented'),
    );
    this.name = 'NotImplementedError';
  }
}
