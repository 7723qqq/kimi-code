/**
 * Render thrown values as human-readable lines for logs and CLI output.
 *
 * Shared infrastructure: this package carries its own copy of the module that
 * also lives in agent-core-v2's `_base/errors`. The engine does NOT re-export
 * this file — the two are independent copies that cannot be merged (`kosong`
 * is a frozen legacy kernel and the engine's import-boundary check forbids it
 * from depending on this package).
 */

import { isCodedError } from './serialize';

export function toErrorMessage(error: unknown, verbose = false): string {
  if (isCodedError(error)) {
    const base = `[${error.code}] ${error.message}`;
    return verbose && error.details ? `${base} ${JSON.stringify(error.details)}` : base;
  }
  if (error instanceof Error) {
    const base = error.message || error.name;
    if (verbose && error.cause !== undefined) {
      return `${base} (caused by: ${toErrorMessage(error.cause)})`;
    }
    return base;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
