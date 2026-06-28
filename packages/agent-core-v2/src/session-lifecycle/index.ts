/**
 * `session-lifecycle` domain barrel — re-exports the session-lifecycle contract
 * (`sessionLifecycle`) and its scoped service (`sessionLifecycleService`).
 * Importing this barrel registers the `ISessionLifecycleService` binding into
 * the scope registry.
 */

export * from './sessionLifecycle';
export * from './sessionLifecycleService';
