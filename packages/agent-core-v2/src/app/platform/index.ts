/**
 * `platform` domain barrel — re-exports the platform contract and its
 * App-scoped service. Importing this barrel registers the `IPlatformService`
 * binding and the `platforms` config section.
 */

import './configSection';

export * from './platform';
export * from './platformService';
