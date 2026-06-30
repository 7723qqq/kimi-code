/**
 * `skill` domain barrel — re-exports the skill contracts and their scoped
 * services plus the in-memory catalog Store backend. Importing this barrel
 * registers the `IAgentSkillService`, `IGlobalSkillCatalog`, `ISessionSkillCatalog`,
 * and the default in-memory `ISkillCatalogStore` bindings into the scope
 * registry.
 */

export * from './skill';
export * from './types';
export * from './parser';
export * from './registry';
export * from './skillCatalogStore';
export * from './inMemorySkillCatalogStore';
export * from './globalSkillCatalog';
export * from './globalSkillCatalogService';
export * from './skillCatalog';
export * from './skillCatalogService';
export * from './skillService';
