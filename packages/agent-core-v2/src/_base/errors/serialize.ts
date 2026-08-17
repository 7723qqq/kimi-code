/**
 * `errors` domain (cross-cutting) — wire serialization of thrown values.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/errors`
 * (shared infrastructure). Keep this file as a thin re-export so existing
 * `#/_base/errors/serialize` imports stay valid.
 */

export * from '@moonshot-ai/kosong/errors/serialize';
