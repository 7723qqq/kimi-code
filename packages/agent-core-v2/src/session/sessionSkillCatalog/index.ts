/**
 * `sessionSkillCatalog` domain barrel — re-exports the per-session skill
 * catalog contract and its Session-scope service. Importing this barrel
 * registers the `ISessionSkillCatalog` binding into the scope registry.
 */

export * from './skillCatalog';
export * from './skillCatalogService';
