/**
 * `authLegacy` domain barrel — re-exports the v1 auth-readiness adapter
 * contract (`authLegacy`) and its scoped service (`authLegacyService`).
 * Importing this barrel registers the `IAuthLegacyService` binding into the
 * scope registry.
 */

export * from './authLegacy';
export * from './authLegacyService';
