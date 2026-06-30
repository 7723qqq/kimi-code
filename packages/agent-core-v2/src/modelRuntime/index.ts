/**
 * `modelRuntime` domain barrel — re-exports the model-runtime contract
 * (`modelRuntime`) and its runtime implementation (`modelResolverService`).
 * `ISessionModelResolver` is registered as a Session-scoped service (built from
 * `IConfigService` + `IOAuthService`); `modelResolverSeed` remains available
 * as a host/test override seam.
 */

export * from './modelResolverService';
export * from './modelRuntime';
