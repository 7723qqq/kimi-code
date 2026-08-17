/**
 * `kosong/contract` domain — the provider-agnostic tool definition.
 *
 * Re-export layer: the implementation moved to `@moonshot-ai/kosong/tool`
 * (shared contract layer). Keep this file as a thin re-export so existing
 * `#/kosong/contract/tool` imports stay valid.
 */

export * from '@moonshot-ai/kosong/tool';
