/**
 * `media` domain — built-in tools that read multi-modal file content.
 *
 * Currently only `ReadMediaFile`, plus the capability-gated
 * `registerMediaTools` registrar and the `createVideoUploader` helper. The
 * shared magic-byte detection lives in `#/_base/tools/support/file-type` so
 * the future Read/Write/Edit tools can reuse it.
 */

export * from './registerMediaTools';
export * from '#/agent/media/tools/read-media';
