/**
 * `kosong/contract` domain — live request provenance contract.
 *
 * Re-export layer: the implementation moved to
 * `@moonshot-ai/kosong/request-trace` (shared contract layer). Keep this
 * file as a thin re-export so existing `#/kosong/contract/requestTrace`
 * imports stay valid.
 */

export * from '@moonshot-ai/kosong/request-trace';
