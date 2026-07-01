/**
 * `flag` domain barrel — re-exports the flag registry contract/implementation,
 * the resolution contract, and the scoped service. Importing this barrel
 * registers the `IFlagRegistry` and `IFlagService` bindings into the scope
 * registry.
 */

export * from './flagRegistry';
export * from './flagRegistryService';
export * from './flag';
export * from './flagService';
