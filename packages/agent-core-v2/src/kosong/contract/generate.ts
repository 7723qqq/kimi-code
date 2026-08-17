/**
 * `kosong/contract` domain — the generation driver.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/generate`
 * (shared contract layer). Keep this file as a thin re-export so existing
 * `#/kosong/contract/generate` imports stay valid.
 */

export * from '@moonshot-ai/kosong/generate';
