/**
 * `tool` domain barrel — re-exports the foundational tool model contract
 * (`toolContract`), the resource-access declarations (`tool-access`), the
 * execution hook contexts (`toolHooks`), and the tool-name predicates
 * (`toolName`). Pure contract domain; importing it registers no scoped
 * service.
 */

export * from './toolContract';
export * from './tool-access';
export * from './toolHooks';
export * from './toolName';
