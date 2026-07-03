/**
 * `web` domain barrel — re-exports the web contract (`web`), its scoped
 * service (`webService`), the fetch providers, and a side-effect import of the
 * `FetchURL` tool so its `registerTool(...)` call runs at module load.
 * Importing this barrel registers the `IWebFetchService` binding into the scope
 * registry and adds `FetchURL` to the tool contribution list.
 */

import './tools/fetch-url';

export * from './web';
export * from './webService';
export * from './providers/local-fetch-url';
export * from './providers/moonshot-fetch-url';
