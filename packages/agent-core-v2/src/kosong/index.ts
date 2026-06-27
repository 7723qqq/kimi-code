/**
 * `kosong` domain barrel — re-exports the kosong contracts and scoped
 * services. Importing this barrel registers the `IProtocolHandlerRegistry`
 * binding into the scope registry; `IProviderManager` is installed into a
 * Session scope by the host via `providerManagerSeed`.
 */

export * from './errors';
export * from './protocolHandlerRegistry';
export * from './providerManager';
