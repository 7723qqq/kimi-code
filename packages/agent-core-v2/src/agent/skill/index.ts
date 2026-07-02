/**
 * `skill` domain barrel — re-exports the agent skill contract and its
 * Agent-scope service, plus the `skillTools` registrar. Importing this barrel
 * registers the `IAgentSkillService` and `IAgentSkillToolsService` bindings into
 * the scope registry.
 */

export * from './skill';
export * from './skillService';
export * from './skillTools';
export * from './skillToolsService';
