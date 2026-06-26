/**
 * `toolDedup` domain barrel — re-exports the tool-call deduplication
 * contract (`toolDedup`) and its scoped service (`toolDedupService`). Importing
 * this barrel registers the `IToolDedupService` binding into the scope registry.
 */

export * from './toolDedup';
export * from './toolDedupService';
