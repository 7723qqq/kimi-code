/**
 * `git` domain barrel — re-exports the git contract (`git`), its scoped
 * service (`gitService`), the pure parsers (`gitParsers`), and the git error
 * codes (`errors`). Importing this barrel registers the `IGitService` binding
 * into the scope registry.
 */

export * from './git';
export * from './gitParsers';
export * from './gitService';
