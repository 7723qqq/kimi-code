/**
 * `tool` domain barrel — re-exports the foundational tool contract
 * (`toolContract`) and the resource-access declarations (`tool-access`).
 * Pure contract domain; importing it registers no scoped service.
 */

export * from './toolContract';
export * from './tool-access';
