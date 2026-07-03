/**
 * `globalSkillCatalog` domain barrel — re-exports the skill catalog
 * contracts, parsers, registry, and the App-scope catalog services. Importing
 * this barrel registers the `IGlobalSkillCatalog` and the default in-memory
 * `ISkillDiscovery` bindings into the scope registry.
 */

export * from './types';
export * from './parser';
export * from './registry';
export * from './skillDiscovery';
export * from './inMemorySkillDiscovery';
export * from './globalSkillCatalog';
export * from './globalSkillCatalogService';
