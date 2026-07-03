/**
 * `session` domain barrel — re-exports the session warning contract
 * (`sessionWarning`) and its scoped service (`sessionWarningService`).
 * Importing this barrel registers the warning service binding into the scope
 * registry.
 */

export * from './sessionWarning';
export * from './sessionWarningService';
