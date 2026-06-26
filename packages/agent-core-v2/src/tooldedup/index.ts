/**
 * `toolDedup` domain barrel — re-exports the tool-call deduplication
 * contract (`toolDedupe`) and its scoped service (`toolDedupeService`). Importing
 * this barrel registers the `IToolDedupe` binding into the scope registry.
 */

export * from './toolDedupe';
export * from './toolDedupeService';
