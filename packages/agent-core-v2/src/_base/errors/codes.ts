/**
 * `errors` domain (cross-cutting) — error-code contract, runtime registry, and
 * metadata backing serialization.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/errors`
 * (shared infrastructure). Re-exporting keeps the module-level
 * `registerErrorDomain(CoreErrors)` side effect (importing this module
 * registers the core codes in the shared registry) and keeps existing
 * `#/_base/errors/codes` imports valid.
 */

export * from '@moonshot-ai/kosong/errors/codes';
