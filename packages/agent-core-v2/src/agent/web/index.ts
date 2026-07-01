/**
 * `web` domain barrel — re-exports the web contract (`web`) and its scoped
 * service (`webService`). Importing this barrel registers the `IAgentWebService`
 * binding into the scope registry.
 */

export * from './web';
export * from './webService';
