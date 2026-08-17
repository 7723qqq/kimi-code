/**
 * Unexpected-error reporting hook (`onUnexpectedError`) — surfaces exceptions
 * thrown by listener callbacks.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/errors`
 * (shared infrastructure). Keep this file as a thin re-export so existing
 * `#/_base/errors/unexpectedError` imports stay valid.
 */

export * from '@moonshot-ai/kosong/errors/unexpectedError';
