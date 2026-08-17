/**
 * Base error classes shared by every domain — `Error2` and related
 * control-flow errors.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/errors`
 * (shared infrastructure) so the provider error family can extend the same
 * coded-error base without a dependency cycle. Keep this file as a thin
 * re-export so existing `#/_base/errors/errors` imports stay valid.
 */

export * from '@moonshot-ai/kosong/errors/errors';
