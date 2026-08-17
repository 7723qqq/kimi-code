/**
 * Render thrown values as human-readable lines for logs and CLI output.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/errors`
 * (shared infrastructure). Keep this file as a thin re-export so existing
 * `#/_base/errors/errorMessage` imports stay valid.
 */

export * from '@moonshot-ai/kosong/errors/errorMessage';
