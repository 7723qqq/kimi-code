/**
 * Loop-local error helpers.
 */

import { ErrorCodes, KimiError } from '#/_base/errors';

export function createMaxStepsExceededError(maxSteps: number, message?: string): KimiError {
  return new KimiError(ErrorCodes.LOOP_MAX_STEPS_EXCEEDED, message ?? `Turn exceeded maxSteps=${maxSteps}`, {
    details: { maxSteps },
  });
}

export function isMaxStepsExceededError(error: unknown): boolean {
  return error instanceof KimiError && error.code === ErrorCodes.LOOP_MAX_STEPS_EXCEEDED;
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError';
  }
  return false;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
