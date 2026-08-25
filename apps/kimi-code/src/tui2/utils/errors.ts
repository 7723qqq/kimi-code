/**
 * Framework-agnostic error classification: distinguish abort errors from other
 * failures so the TUI can decide whether to stop a stream gracefully.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

function isAbortMessage(message: string): boolean {
  return message === 'Aborted' || message.endsWith(': Aborted');
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || isAbortMessage(error.message);
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { readonly message?: unknown }).message;
    return typeof message === 'string' && isAbortMessage(message);
  }
  return isAbortMessage(String(error));
}
