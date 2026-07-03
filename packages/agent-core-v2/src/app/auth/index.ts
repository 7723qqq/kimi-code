/**
 * `auth` domain barrel — re-exports the auth contract (`auth`), its scoped
 * services (`authService`), the OAuth-backed web-search seam (`webSearch`),
 * and a side-effect import of the `WebSearch` tool so its `registerTool(...)`
 * call runs at module load. Importing this barrel registers the
 * `IOAuthService`, `IAuthSummaryService`, and `IWebSearchProviderService`
 * bindings into the scope registry and conditionally adds `WebSearch` to the
 * tool contribution list.
 */

import './webSearch/tools/web-search';

export * from './auth';
export * from './authService';
export * from './webSearch/webSearch';
export * from './webSearch/webSearchService';
export * from './webSearch/providers/moonshot-web-search';
