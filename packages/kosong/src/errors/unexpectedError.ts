/**
 * Unexpected-error reporting hook (`onUnexpectedError`) — surfaces exceptions
 * thrown by listener callbacks.
 *
 * Shared infrastructure: this package carries its own copy of the module that
 * also lives in agent-core-v2's `_base/errors`. The engine does NOT re-export
 * this file — the two are independent copies that cannot be merged (`kosong`
 * is a frozen legacy kernel and the engine's import-boundary check forbids it
 * from depending on this package).
 */

export type UnexpectedErrorHandler = (err: unknown) => void;

const defaultHandler: UnexpectedErrorHandler = (err) => {
  // eslint-disable-next-line no-console
  console.error('[unexpected]', err);
};

let currentHandler: UnexpectedErrorHandler = defaultHandler;

export function setUnexpectedErrorHandler(handler: UnexpectedErrorHandler): void {
  currentHandler = handler;
}

export function resetUnexpectedErrorHandler(): void {
  currentHandler = defaultHandler;
}

export function onUnexpectedError(err: unknown): void {
  try {
    currentHandler(err);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[unexpected] handler threw', error, 'while reporting', err);
  }
}

export function safelyCallListener(listener: () => void): void {
  try {
    listener();
  } catch (error) {
    onUnexpectedError(error);
  }
}
